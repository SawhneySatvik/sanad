// FallbackLlmClient as a chain of more than two tiers: which tier answers, the one quick retry on a
// transport failure, circuit breakers, the per-tier share of the budget, and capability routing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { CircuitBreaker, FAILURE_THRESHOLD, OPEN_MS } from "@/server/llm/circuit-breaker";
import { normalizeProviderError, streamEventError, toStreamErrorEvent } from "@/server/llm/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { FallbackLlmClient } from "@/server/llm/fallback";
import { MIN_FALLBACK_BUDGET_MS, TIER_BUDGET_SHARE } from "@/server/llm/timeouts";
import type { LlmClient, LlmCompleteInput, LlmStreamEvent } from "@/server/llm/types";

const schema = z.object({ answer: z.string() });
const call = { systemPrompt: "s", userPrompt: "u", schema };
const nativePdf = [{ nativeFile: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } }];

const upstream = () => new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
const timeout = () => new AppError("TIMEOUT", safeMessageFor("TIMEOUT"));
const provider429 = () => normalizeProviderError({ status: 429 });
const provider404 = () => normalizeProviderError({ status: 404 });
// A Google-shaped 429 stating a RetryInfo delay, the shape @google/genai's ApiError.message carries.
const retryDelay429 = (seconds: number) =>
  normalizeProviderError({
    status: 429,
    message: JSON.stringify({ error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${seconds}s` }] } }),
  });
// A Google-shaped 429 naming a per-day quota, the shape @google/genai's ApiError.message carries.
const perDayQuota429 = () =>
  normalizeProviderError({
    status: 429,
    message: JSON.stringify({
      error: {
        code: 429,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
          },
        ],
      },
    }),
  });
// Exactly what an adapter produces when the request got no HTTP response.
const transport = () => normalizeProviderError(new TypeError("fetch failed"));
const ownLimiter = () => new AppError("RATE_LIMITED", safeMessageFor("RATE_LIMITED"), { retryAfterSeconds: 30 });
const schemaFailed = () => new AppError("SCHEMA_FAILED", safeMessageFor("SCHEMA_FAILED"));

const answers = (model: string, answer = `from ${model}`) => new FakeLlmClient({ modelUsed: model, defaultResponse: { data: { answer } } });
const fails = (model: string, ...errors: AppError[]) => new FakeLlmClient({ modelUsed: model, responses: errors.map((error) => ({ error })) });

async function streamOf(client: LlmClient, input: LlmCompleteInput<typeof schema> = call) {
  const events: LlmStreamEvent<typeof schema>[] = [];
  for await (const event of client.stream(input)) events.push(event);
  return events;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a chain of tiers: the first tier that answers is the one recorded", () => {
  it("complete(): modelUsed names the fourth tier; each earlier tier was tried exactly once", async () => {
    const tiers = [fails("primary", upstream()), fails("lite", provider429()), fails("gemma-google", timeout()), answers("gemma-nim")];
    const result = await new FallbackLlmClient(tiers[0], ...tiers.slice(1)).complete(call);

    expect(result).toMatchObject({ data: { answer: "from gemma-nim" }, modelUsed: "gemma-nim" });
    expect(tiers.map((tier) => tier.callCount)).toEqual([1, 1, 1, 1]);
  });

  it("stream(): the done event carries the fourth tier's modelUsed, and no earlier tier's error is emitted", async () => {
    const tiers = [fails("primary", upstream()), fails("lite", provider429()), fails("gemma-google", timeout()), answers("gemma-nim")];
    const events = await streamOf(new FallbackLlmClient(tiers[0], ...tiers.slice(1)));

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", modelUsed: "gemma-nim", data: { answer: "from gemma-nim" } });
  });

  it("a fallback tier that rejects the request (4xx) or answers unusably does not stop the chain", async () => {
    const unusable = new FakeLlmClient({ modelUsed: "gemma-google", responses: [{ rawText: "not json" }, { rawText: "still not json" }] });
    const last = answers("gemma-nim");
    const client = new FallbackLlmClient(fails("primary", upstream()), fails("lite", provider404()), unusable, last);

    expect((await client.complete(call)).modelUsed).toBe("gemma-nim");
    expect(unusable.callCount).toBe(1);
  });

  it("the primary's own 4xx still stops the chain: our request is wrong, and a backup would hide it", async () => {
    const fallback = answers("lite");
    const rejected = provider404();
    await expect(new FallbackLlmClient(fails("primary", rejected), fallback).complete(call)).rejects.toBe(rejected);
    expect(fallback.callCount).toBe(0);
  });

  it("every tier failed at the provider: the primary's error surfaces, not the last backup's", async () => {
    const primaryError = timeout();
    const client = new FallbackLlmClient(fails("primary", primaryError), fails("lite", provider429()), fails("gemma", upstream()), fails("nim", provider404()));
    expect(await rejectionOf(client.complete(call))).toBe(primaryError);
  });

  it("every tier failed, one with a real answer (SCHEMA_FAILED): that one surfaces, on complete() and stream()", async () => {
    const make = () =>
      new FallbackLlmClient(fails("primary", timeout()), fails("lite", provider429()), fails("gemma", schemaFailed()), fails("nim", upstream()));
    expect(await rejectionOf(make().complete(call))).toMatchObject({ code: "SCHEMA_FAILED" });
    expect(await streamOf(make())).toEqual([{ type: "error", code: "SCHEMA_FAILED", retryable: false }]);
  });
});

describe("one quick retry on the same tier when a call got no HTTP response", () => {
  it("complete(): a transport failure is retried once on the same tier, which then answers; the next tier is never called", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: transport() }, { data: { answer: "second try" } }] });
    const next = answers("lite");
    const result = await new FallbackLlmClient(primary, next).complete({ ...call, timeoutMs: 120_000 });

    expect(result).toMatchObject({ modelUsed: "primary", data: { answer: "second try" } });
    expect(primary.callCount).toBe(2);
    expect(next.callCount).toBe(0);
    // The retry runs inside the tier's own window, not a fresh one.
    expect(primary.calls[1].timeoutMs!).toBeLessThanOrEqual(primary.calls[0].timeoutMs!);
  });

  it("complete(): retried at most once — a second transport failure falls through to the next tier", async () => {
    const primary = fails("primary", transport(), transport(), transport());
    const result = await new FallbackLlmClient(primary, answers("lite")).complete(call);

    expect(result.modelUsed).toBe("lite");
    expect(primary.callCount).toBe(2);
  });

  it("an error that got a response (503, 429) or a timeout is not retried on the same tier", async () => {
    for (const error of [upstream(), normalizeProviderError({ status: 503 }), provider429(), timeout()]) {
      const primary = fails("primary", error, transport());
      expect((await new FallbackLlmClient(primary, answers("lite")).complete(call)).modelUsed).toBe("lite");
      expect(primary.callCount).toBe(1);
    }
  });

  it(`no retry is started with less than MIN_FALLBACK_BUDGET_MS (${MIN_FALLBACK_BUDGET_MS} ms) left of the tier's window`, async () => {
    const failure = transport();
    const primary = fails("primary", failure, transport());
    await expect(new FallbackLlmClient(primary).complete({ ...call, timeoutMs: MIN_FALLBACK_BUDGET_MS - 1_000 })).rejects.toBe(failure);
    expect(primary.callCount).toBe(1);
  });

  it("stream(): a transport failure before any token is retried once; the retry's tokens and done are what the caller gets", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: transport() }, { data: { answer: "second try" } }] });
    const next = answers("lite");
    const events = await streamOf(new FallbackLlmClient(primary, next));

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", modelUsed: "primary", data: { answer: "second try" } });
    expect(primary.callCount).toBe(2);
    expect(next.callCount).toBe(0);
  });
});

describe("a circuit breaker per tier", () => {
  let now: number;
  beforeEach(() => {
    now = 5_000_000;
  });
  const breaker = (name: string) => new CircuitBreaker(name, { now: () => now });

  it(`after ${FAILURE_THRESHOLD} consecutive provider failures the tier is skipped without being called; the next tier answers`, async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", defaultResponse: { error: upstream() } });
    const client = new FallbackLlmClient({ client: primary, breaker: breaker("gemini:primary") }, answers("lite"));

    for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) expect((await client.complete(call)).modelUsed).toBe("lite");
    expect(primary.callCount).toBe(FAILURE_THRESHOLD);
  });

  it("a single per-day-quota 429 opens the tier immediately: the next call skips it without spending time on it, and the fallback answers", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: perDayQuota429() }] });
    const client = new FallbackLlmClient({ client: primary, breaker: breaker("gemini:primary") }, answers("lite"));

    expect((await client.complete(call)).modelUsed).toBe("lite");
    expect(primary.callCount).toBe(1);

    expect((await client.complete(call)).modelUsed).toBe("lite");
    expect(primary.callCount).toBe(1);
  });

  it("a skipped tier still reports its real cause: when every tier fails, the primary's provider-side 429 surfaces as our own 503, never a raw provider 429", async () => {
    const lastReal = provider429();
    const primary = new FakeLlmClient({ responses: [{ error: upstream() }, { error: upstream() }, { error: lastReal }] });
    const client = new FallbackLlmClient({ client: primary, breaker: breaker("gemini:primary") }, new FakeLlmClient({ defaultResponse: { error: timeout() } }));

    for (let i = 0; i < FAILURE_THRESHOLD; i++) await rejectionOf(client.complete(call));
    expect(await rejectionOf(client.complete(call))).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(await streamOf(client)).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: true }]);
    expect(primary.callCount).toBe(FAILURE_THRESHOLD);
  });

  it("after OPEN_MS one trial call reaches the tier; its success closes the breaker and the tier serves again", async () => {
    const primary = new FakeLlmClient({
      modelUsed: "primary",
      responses: Array.from({ length: FAILURE_THRESHOLD }, () => ({ error: upstream() })),
      defaultResponse: { data: { answer: "recovered" } },
    });
    const client = new FallbackLlmClient({ client: primary, breaker: breaker("gemini:primary") }, answers("lite"));
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await client.complete(call);

    now += OPEN_MS - 1;
    expect((await client.complete(call)).modelUsed).toBe("lite");
    now += 1;
    expect((await client.complete(call)).modelUsed).toBe("primary");
    expect((await client.complete(call)).modelUsed).toBe("primary");
    expect(primary.callCount).toBe(FAILURE_THRESHOLD + 2);
  });

  it("our own rate limit, an unusable answer, a 4xx and a cancelled call never open it", async () => {
    for (const failure of [ownLimiter, schemaFailed, provider404]) {
      const primary = new FakeLlmClient({ defaultResponse: { error: failure() } });
      const client = new FallbackLlmClient({ client: primary, breaker: breaker("gemini:primary") }, answers("lite"));
      for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) await client.complete(call).catch(() => undefined);
      expect(primary.callCount).toBe(FAILURE_THRESHOLD + 2);
    }

    const cancelled = new AbortController();
    cancelled.abort();
    const tierBreaker = breaker("gemini:primary");
    const primary = new FakeLlmClient({ defaultResponse: { error: upstream() } });
    const client = new FallbackLlmClient({ client: primary, breaker: tierBreaker }, answers("lite"));
    for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) await client.complete({ ...call, signal: cancelled.signal }).catch(() => undefined);
    expect(tierBreaker.acquire().allowed).toBe(true);
  });

  it("stream(): a consumer that stops early during the half-open trial frees the trial, so the tier is not skipped for good", async () => {
    const tierBreaker = breaker("gemini:primary");
    for (let i = 0; i < FAILURE_THRESHOLD; i++) tierBreaker.recordFailure(upstream());
    now += OPEN_MS;
    const client = new FallbackLlmClient({ client: answers("primary", "a long streamed answer"), breaker: tierBreaker }, answers("lite"));

    for await (const event of client.stream(call)) {
      expect(event).toMatchObject({ type: "token" });
      break;
    }
    expect(tierBreaker.acquire()).toEqual({ allowed: true });
  });

  it("stream(): an open tier's stream() is never called; the next tier streams the answer", async () => {
    const primary = new FakeLlmClient({ defaultResponse: { error: upstream() } });
    const tierBreaker = breaker("gemini:primary");
    for (let i = 0; i < FAILURE_THRESHOLD; i++) tierBreaker.recordFailure(upstream());
    const streamSpy = vi.spyOn(primary, "stream");

    const events = await streamOf(new FallbackLlmClient({ client: primary, breaker: tierBreaker }, answers("lite")));
    expect(events.at(-1)).toMatchObject({ type: "done", modelUsed: "lite" });
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("every tier open, none called: 503 UPSTREAM_UNAVAILABLE, never the provider's own 429, with retryAfterSeconds the shortest remaining window across tiers, rounded up", async () => {
    const primaryBreaker = breaker("gemini:primary"); // opens for OPEN_MS (60s > the 12s stated); original retryAfterSeconds = 12
    primaryBreaker.recordFailure(retryDelay429(12));
    const liteBreaker = new CircuitBreaker("gemini:lite", { now: () => now, openMs: 45_000 }); // its own, shorter base window
    for (let i = 0; i < FAILURE_THRESHOLD; i++) liteBreaker.recordFailure(upstream());

    now += 30_500; // primary remaining: 29_500ms; lite remaining: 14_500ms -> ceil(14.5s) = 15s, the shortest
    const client = new FallbackLlmClient({ client: answers("primary"), breaker: primaryBreaker }, { client: answers("lite"), breaker: liteBreaker });

    const error = await rejectionOf(client.complete(call));
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 15 });
  });

  it("every tier open, none called: retryAfterSeconds never drops below the original stated delay", async () => {
    const primaryBreaker = breaker("gemini:primary"); // opens for max(OPEN_MS, 100s) = 100s; original retryAfterSeconds = 100
    primaryBreaker.recordFailure(retryDelay429(100));
    const liteBreaker = new CircuitBreaker("gemini:lite", { now: () => now, openMs: 10_000 }); // near-elapsed short window
    for (let i = 0; i < FAILURE_THRESHOLD; i++) liteBreaker.recordFailure(upstream());

    now += 9_000; // lite's own remaining is only 1s, far below the primary's stated 100s
    const client = new FallbackLlmClient({ client: answers("primary"), breaker: primaryBreaker }, { client: answers("lite"), breaker: liteBreaker });

    const error = await rejectionOf(client.complete(call));
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 100 });
  });

  it("a tier that actually gets called still has retryAfterSeconds raised to match a later tier's own open window", async () => {
    const liteBreaker = breaker("gemini:lite");
    for (let i = 0; i < FAILURE_THRESHOLD; i++) liteBreaker.recordFailure(upstream());
    const primaryError = retryDelay429(5);
    const client = new FallbackLlmClient(fails("primary", primaryError), { client: answers("lite"), breaker: liteBreaker });

    const error = await rejectionOf(client.complete(call));
    // primary carries no breaker at all here, so it contributes no signal either way; lite's own
    // breaker — open for the full OPEN_MS (60s) — is the only breakered tier in the chain, and every
    // breakered tier being open is what raises retryAfterSeconds past primary's own stated 5s.
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 60 });
  });

  it("a healthy (closed) sibling tier means the chain would reach it on the next call regardless — retryAfterSeconds stays the provider's own stated delay, not the failed tier's open window", async () => {
    const primaryBreaker = breaker("gemini:primary");
    const primary = new FakeLlmClient({ modelUsed: "primary", defaultResponse: { error: retryDelay429(9) } });
    const liteBreaker = breaker("gemini:lite");
    const lite = new FakeLlmClient({ modelUsed: "lite", defaultResponse: { error: upstream() } }); // one failure — below FAILURE_THRESHOLD, so liteBreaker stays closed
    const client = new FallbackLlmClient({ client: primary, breaker: primaryBreaker }, { client: lite, breaker: liteBreaker });

    const error = await rejectionOf(client.complete(call));
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 9 });
  });

  it("a just-attempted tier's own breaker sets retryAfterSeconds, not only the provider's stated delay: a 9s delay opens the breaker for OPEN_MS (60s)", async () => {
    // { client, breaker } — the same tier shape providers.ts's withBreaker() builds in production,
    // so this proves the fix against a breaker actually attached to the tier that failed, not a
    // pre-seeded one belonging to some other tier.
    const primaryBreaker = breaker("gemini:primary");
    const primary = new FakeLlmClient({ modelUsed: "primary", defaultResponse: { error: retryDelay429(9) } });
    const client = new FallbackLlmClient({ client: primary, breaker: primaryBreaker });

    const error = await rejectionOf(client.complete(call));
    // The only breakered tier in the chain (no fallback at all here) is open, so it sets the floor.
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 60 });
  });

  it("stream(): a just-attempted tier's own breaker sets the underlying error's retryAfterSeconds the same way complete() does", async () => {
    const primaryBreaker = breaker("gemini:primary");
    const primary = new FakeLlmClient({ modelUsed: "primary", defaultResponse: { error: retryDelay429(9) } });
    const client = new FallbackLlmClient({ client: primary, breaker: primaryBreaker });

    const [event] = await streamOf(client);
    expect(event).toMatchObject({ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: true });
    if (event.type !== "error") throw new Error("expected an error event");
    expect(streamEventError(event)).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 60 });
  });

  it("our own limiter's RATE_LIMITED (no provider status) is never converted to UPSTREAM_UNAVAILABLE, even when every tier fails with it", async () => {
    const ownLimit = ownLimiter();
    const client = new FallbackLlmClient(fails("primary", ownLimit), fails("lite", ownLimit));
    expect(await rejectionOf(client.complete(call))).toMatchObject({ code: "RATE_LIMITED" });
  });
});

// A tier that hangs until its window runs out, on a simulated clock: it moves the clock forward by the
// timeoutMs it was given, then fails the way a real timeout does.
function hangsForItsWindow(clock: { now: number }) {
  const windows: number[] = [];
  const client: LlmClient = {
    capabilities: { structuredOutput: true, nativeDocumentInput: true, streaming: true },
    async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<never> {
      windows.push(input.timeoutMs!);
      clock.now += input.timeoutMs!;
      throw timeout();
    },
    async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
      windows.push(input.timeoutMs!);
      clock.now += input.timeoutMs!;
      yield toStreamErrorEvent(timeout());
    },
  };
  return { client, windows };
}

describe("a per-tier time cap inside the chain's budget", () => {
  const clock = { now: 0 };
  beforeEach(() => {
    clock.now = 10_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  });

  it(`a hung tier may spend only TIER_BUDGET_SHARE (${TIER_BUDGET_SHARE}) of the budget, leaving the rest to the next tier (complete and stream)`, async () => {
    for (const run of ["complete", "stream"] as const) {
      const hung = hangsForItsWindow(clock);
      const next = answers("lite");
      const client = new FallbackLlmClient(hung.client, next);
      const input = { ...call, timeoutMs: 120_000 };
      const modelUsed = run === "complete" ? (await client.complete(input)).modelUsed : (await streamOf(client, input)).at(-1);

      expect(modelUsed).toEqual(run === "complete" ? "lite" : expect.objectContaining({ type: "done", modelUsed: "lite" }));
      expect(hung.windows).toEqual([120_000 * TIER_BUDGET_SHARE]);
      expect(next.calls[0].timeoutMs).toBe(120_000 * (1 - TIER_BUDGET_SHARE));
    }
  });

  it("a middle tier that hangs is capped too, so the tiers after it still get a turn", async () => {
    const hung = hangsForItsWindow(clock);
    const last = answers("gemma");
    const result = await new FallbackLlmClient(fails("primary", provider429()), hung.client, last).complete({ ...call, timeoutMs: 120_000 });

    expect(result.modelUsed).toBe("gemma");
    expect(hung.windows).toEqual([90_000]);
    expect(last.calls[0].timeoutMs).toBe(30_000);
  });

  it("the last tier that can run gets everything left, not a share: later tiers that are open or cannot read the input don't count", async () => {
    const open = new CircuitBreaker("nim", { now: () => clock.now });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) open.recordFailure(upstream());
    const second = answers("lite");
    await new FallbackLlmClient(fails("primary", provider429()), second, { client: answers("nim"), breaker: open }).complete({ ...call, timeoutMs: 120_000 });
    expect(second.calls[0].timeoutMs).toBe(120_000);

    const nativeSecond = new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, modelUsed: "lite", defaultResponse: { data: { answer: "x" } } });
    const primary = new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, responses: [{ error: provider429() }] });
    await new FallbackLlmClient(primary, nativeSecond, answers("gemma-text-only")).complete({ ...call, documents: nativePdf, timeoutMs: 120_000 });
    expect(nativeSecond.calls[0].timeoutMs).toBe(120_000);
  });

  it("a single tier, or a chain with no budget, is not capped", async () => {
    const only = answers("primary");
    await new FallbackLlmClient(only).complete({ ...call, timeoutMs: 120_000 });
    expect(only.calls[0].timeoutMs).toBe(120_000);

    const unbounded = answers("primary");
    await new FallbackLlmClient(unbounded, answers("lite")).complete(call);
    expect(unbounded.calls[0].timeoutMs).toBeUndefined();
  });
});

describe("capability routing: a request carrying a native document skips tiers that cannot read one", () => {
  const nativeFails = () => new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, modelUsed: "primary", responses: [{ error: upstream() }] });
  const nativeAnswers = () => new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, modelUsed: "lite", defaultResponse: { data: { answer: "transcribed" } } });

  it("complete(): the text-only Gemma tier is never called; the next native-capable tier answers", async () => {
    const textOnly = answers("gemma");
    const completeSpy = vi.spyOn(textOnly, "complete");
    const result = await new FallbackLlmClient(nativeFails(), textOnly, nativeAnswers()).complete({ ...call, documents: nativePdf });

    expect(result).toMatchObject({ modelUsed: "lite", data: { answer: "transcribed" } });
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("stream(): same routing", async () => {
    const textOnly = answers("gemma");
    const streamSpy = vi.spyOn(textOnly, "stream");
    const events = await streamOf(new FallbackLlmClient(nativeFails(), textOnly, nativeAnswers()), { ...call, documents: nativePdf });

    expect(events.at(-1)).toMatchObject({ type: "done", modelUsed: "lite" });
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("a text request still reaches the text-only tier", async () => {
    const result = await new FallbackLlmClient(fails("primary", upstream()), answers("gemma")).complete({ ...call, documents: [{ canonicalText: "t" }] });
    expect(result.modelUsed).toBe("gemma");
  });
});
