import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { CircuitBreaker, FAILURE_THRESHOLD, MAX_OPEN_MS, OPEN_MS } from "@/server/llm/circuit-breaker";
import { normalizeProviderError } from "@/server/llm/errors";

const failure = (code: "TIMEOUT" | "UPSTREAM_UNAVAILABLE" = "UPSTREAM_UNAVAILABLE") => new AppError(code, safeMessageFor(code));

// A Google-shaped 429 body, the same shape @google/genai's ApiError.message carries (JSON.stringify
// of the whole response body, no prefix — see errors.ts).
function google429(details: Record<string, unknown>[]): AppError {
  return normalizeProviderError({
    status: 429,
    message: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details } }),
  });
}
const retryDelay429 = (seconds: number) => google429([{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${seconds}s` }]);
// Carries both details, the way a real per-day-exhausted response can: a short RetryInfo delay
// alongside the QuotaFailure, to prove the per-day check outranks it rather than just being untested.
const perDayQuota429 = () =>
  google429([
    {
      "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaMetric: "generativelanguage.googleapis.com/x" }],
    },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20s" },
  ]);
const plain429 = () => normalizeProviderError({ status: 429 });

let now = 1_000_000;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now = 1_000_000;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

function breaker(): CircuitBreaker {
  return new CircuitBreaker("nim:google/gemma-4-31b-it", { now: () => now });
}

function fail(b: CircuitBreaker, times: number, error: AppError = failure()): void {
  for (let i = 0; i < times; i++) {
    expect(b.acquire().allowed).toBe(true);
    b.recordFailure(error);
  }
}

describe("CircuitBreaker", () => {
  it(`stays closed below ${FAILURE_THRESHOLD} consecutive failures, and opens on that many — logging it once`, () => {
    const b = breaker();
    fail(b, FAILURE_THRESHOLD - 1);
    expect(b.acquire()).toEqual({ allowed: true });
    expect(warn).not.toHaveBeenCalled();

    const last = failure("TIMEOUT");
    b.recordFailure(last);
    expect(b.acquire()).toEqual({ allowed: false, lastError: last });
    expect(b.isAvailable()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      event: "llm_circuit_open",
      tier: "nim:google/gemma-4-31b-it",
      consecutiveFailures: FAILURE_THRESHOLD,
      openMs: OPEN_MS,
      reason: "threshold",
      code: "TIMEOUT",
    });
  });

  it("counts only consecutive failures: a success in between starts the count again", () => {
    const b = breaker();
    fail(b, FAILURE_THRESHOLD - 1);
    b.recordSuccess();
    fail(b, FAILURE_THRESHOLD - 1);
    expect(b.acquire().allowed).toBe(true);
  });

  it("a released call changes nothing: it neither resets nor adds to the count", () => {
    const b = breaker();
    fail(b, FAILURE_THRESHOLD - 1);
    b.acquire();
    b.release();
    b.recordFailure(failure());
    expect(b.acquire().allowed).toBe(false);
  });

  it("a failure from a call that started before the tier opened does not double the window: only a granted trial does", () => {
    const b = breaker();
    // Five calls acquire concurrently while closed; the third failure opens the tier at OPEN_MS.
    for (let i = 0; i < 5; i++) expect(b.acquire().allowed).toBe(true);
    for (let i = 0; i < 5; i++) b.recordFailure(failure());

    expect(warn).toHaveBeenCalledTimes(1);
    now += OPEN_MS;
    expect(b.acquire().allowed).toBe(true);
  });

  it("while open, every call is refused with the error that opened it, until OPEN_MS has passed", () => {
    const b = breaker();
    const opener = failure();
    fail(b, FAILURE_THRESHOLD - 1);
    b.recordFailure(opener);

    now += OPEN_MS - 1;
    expect(b.acquire()).toEqual({ allowed: false, lastError: opener });
    expect(b.isAvailable()).toBe(false);
  });

  it("half-open: after OPEN_MS exactly one trial is let through; a success closes the breaker", () => {
    const b = breaker();
    fail(b, FAILURE_THRESHOLD);
    now += OPEN_MS;

    expect(b.isAvailable()).toBe(true);
    expect(b.acquire()).toEqual({ allowed: true });
    // A second caller while the trial is in flight is still refused.
    expect(b.acquire().allowed).toBe(false);
    expect(b.isAvailable()).toBe(false);

    b.recordSuccess();
    expect(b.acquire()).toEqual({ allowed: true });
    expect(b.acquire()).toEqual({ allowed: true });
  });

  it("half-open: a failed trial re-opens the breaker for double the previous window, carrying the new error", () => {
    const b = breaker();
    fail(b, FAILURE_THRESHOLD);
    now += OPEN_MS;
    expect(b.acquire().allowed).toBe(true);

    const trialError = failure("TIMEOUT");
    b.recordFailure(trialError);
    expect(b.acquire()).toEqual({ allowed: false, lastError: trialError });
    now += 2 * OPEN_MS - 1;
    expect(b.acquire().allowed).toBe(false);
    now += 1;
    expect(b.acquire().allowed).toBe(true);
  });

  it("half-open: a released trial frees the slot for the next caller without closing the breaker", () => {
    const b = breaker();
    fail(b, FAILURE_THRESHOLD);
    now += OPEN_MS;
    expect(b.acquire().allowed).toBe(true);
    b.release();

    expect(b.acquire().allowed).toBe(true);
    b.recordFailure(failure());
    expect(b.acquire().allowed).toBe(false);
  });
});

describe("backoff: repeated half-open trial failures double the window, capped, and a success resets it", () => {
  let now: number;
  beforeEach(() => {
    now = 1_000_000;
  });
  function breaker(): CircuitBreaker {
    return new CircuitBreaker("nim:google/gemma-4-31b-it", { now: () => now });
  }

  it("doubles on each failed trial up to MAX_OPEN_MS, stays capped, then resets to OPEN_MS on success", () => {
    const b = breaker();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      expect(b.acquire().allowed).toBe(true);
      b.recordFailure(failure());
    }

    let window = OPEN_MS;
    for (let i = 0; i < 5; i++) {
      now += window;
      expect(b.acquire().allowed).toBe(true);
      b.recordFailure(failure("TIMEOUT"));
      window = Math.min(window * 2, MAX_OPEN_MS);
      now += window - 1;
      expect(b.acquire().allowed).toBe(false);
    }
    expect(window).toBe(MAX_OPEN_MS);

    now += 1;
    expect(b.acquire().allowed).toBe(true);
    b.recordSuccess();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      expect(b.acquire().allowed).toBe(true);
      b.recordFailure(failure());
    }
    expect(b.acquire().allowed).toBe(false);
    now += OPEN_MS - 1;
    expect(b.acquire().allowed).toBe(false);
    now += 1;
    expect(b.acquire().allowed).toBe(true);
  });

  it("a fresh quota window floors, but never shrinks, an in-progress doubled backoff", () => {
    const b = breaker();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      expect(b.acquire().allowed).toBe(true);
      b.recordFailure(failure());
    }
    now += OPEN_MS;
    expect(b.acquire().allowed).toBe(true);
    b.recordFailure(failure("TIMEOUT")); // doubles OPEN_MS -> 2*OPEN_MS
    now += 2 * OPEN_MS;
    expect(b.acquire().allowed).toBe(true);

    // A 5s stated delay floors to OPEN_MS on its own (max(base, delay)) — far short of the 4*OPEN_MS
    // that doubling produces here, so doubling must still win.
    b.recordFailure(retryDelay429(5));
    now += 4 * OPEN_MS - 1;
    expect(b.acquire().allowed).toBe(false);
    now += 1;
    expect(b.acquire().allowed).toBe(true);
  });

  it("a fresh, longer quota window wins over a smaller doubled value", () => {
    const b = breaker();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      expect(b.acquire().allowed).toBe(true);
      b.recordFailure(failure());
    }
    now += OPEN_MS;
    expect(b.acquire().allowed).toBe(true);

    const longDelay = retryDelay429(300); // far longer than doubling (2*OPEN_MS = 120_000ms)
    b.recordFailure(longDelay);
    now += 300_000 - 1;
    expect(b.acquire().allowed).toBe(false);
    now += 1;
    expect(b.acquire().allowed).toBe(true);
  });
});

describe("quota-aware opening: a 429 that names its own recovery time skips the failure threshold", () => {
  let now: number;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    now = 1_000_000;
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });
  function breaker(): CircuitBreaker {
    return new CircuitBreaker("gemini:gemini-2.5-flash", { now: () => now });
  }

  it("a single 429 stating a retry delay opens immediately, for max(base window, the delay)", () => {
    const b = breaker();
    const error = retryDelay429(90); // 90s > OPEN_MS (60s)
    b.recordFailure(error);

    expect(b.acquire()).toEqual({ allowed: false, lastError: error });
    now += 90_000 - 1;
    expect(b.acquire().allowed).toBe(false);
    now += 1;
    expect(b.acquire().allowed).toBe(true);
    // The last warn line: normalizeProviderError also logs its own llm_provider_rejected line first.
    expect(JSON.parse(String(warn.mock.calls.at(-1)![0]))).toMatchObject({ reason: "provider_retry_delay", openMs: 90_000, consecutiveFailures: 1 });
  });

  it("a stated delay shorter than the base window still opens for the base window, not the delay", () => {
    const b = breaker();
    b.recordFailure(retryDelay429(5));

    now += OPEN_MS - 1;
    expect(b.acquire().allowed).toBe(false);
    now += 1;
    expect(b.acquire().allowed).toBe(true);
  });

  it("a single 429 naming a per-day quota opens immediately for MAX_OPEN_MS, capped, even with a short stated delay", () => {
    const b = breaker();
    b.recordFailure(perDayQuota429());

    expect(b.acquire().allowed).toBe(false);
    now += MAX_OPEN_MS - 1;
    expect(b.acquire().allowed).toBe(false);
    now += 1;
    expect(b.acquire().allowed).toBe(true);
    expect(JSON.parse(String(warn.mock.calls.at(-1)![0]))).toMatchObject({ reason: "per_day_quota", openMs: MAX_OPEN_MS });
  });

  it("a plain per-minute 429 with no stated delay still needs FAILURE_THRESHOLD consecutive failures", () => {
    const b = breaker();
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      expect(b.acquire().allowed).toBe(true);
      b.recordFailure(plain429());
    }
    expect(b.acquire().allowed).toBe(true);

    b.recordFailure(plain429());
    expect(b.acquire().allowed).toBe(false);
    expect(JSON.parse(String(warn.mock.calls.at(-1)![0]))).toMatchObject({ reason: "threshold", openMs: OPEN_MS });
  });

  it("our own rate limiter's RATE_LIMITED (not a provider 429) never opens the breaker immediately", () => {
    const b = breaker();
    const ownLimiter = new AppError("RATE_LIMITED", safeMessageFor("RATE_LIMITED"), { retryAfterSeconds: 30 });
    b.recordFailure(ownLimiter);
    expect(b.acquire().allowed).toBe(true);
  });
});
