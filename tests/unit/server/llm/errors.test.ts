import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/core/errors";
import {
  getProviderStatus,
  isPerDayQuotaError,
  isRetryableProviderError,
  isRetryableProviderErrorCode,
  isTransportFailure,
  normalizeProviderError,
  toStreamErrorEvent,
} from "@/server/llm/errors";

describe("isTransportFailure: a provider call that got no HTTP response", () => {
  it("is true for a failure with no status (fetch failed, connection reset)", () => {
    expect(isTransportFailure(normalizeProviderError(new TypeError("fetch failed")))).toBe(true);
    expect(isTransportFailure(normalizeProviderError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })))).toBe(true);
  });

  it("is false for anything that got a response, an abort, or an AppError built elsewhere", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(isTransportFailure(normalizeProviderError({ status: 503 }))).toBe(false);
      expect(isTransportFailure(normalizeProviderError({ status: 429 }))).toBe(false);
      expect(isTransportFailure(normalizeProviderError({ status: 400 }))).toBe(false);
      expect(isTransportFailure(normalizeProviderError(new DOMException("aborted", "AbortError")))).toBe(false);
      expect(isTransportFailure(new AppError("UPSTREAM_UNAVAILABLE", "built by hand"))).toBe(false);
      expect(isTransportFailure(new TypeError("fetch failed"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("normalizeProviderError", () => {
  it("passes an existing AppError through unchanged", () => {
    const original = new AppError("SCHEMA_FAILED", "structured output failed schema validation.");
    expect(normalizeProviderError(original)).toBe(original);
  });

  it("maps a 429 status to RATE_LIMITED", () => {
    const result = normalizeProviderError({ status: 429 });
    expect(result.code).toBe("RATE_LIMITED");
  });

  it("carries retry-after from a Headers-like object on the error", () => {
    const headers = new Headers({ "retry-after": "42" });
    const result = normalizeProviderError({ status: 429, headers });
    expect(result.retryAfterSeconds).toBe(42);
  });

  it("leaves retryAfterSeconds undefined when there is no retry-after header", () => {
    const result = normalizeProviderError({ status: 429, headers: new Headers() });
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it("maps a 500 status to UPSTREAM_UNAVAILABLE", () => {
    expect(normalizeProviderError({ status: 500 }).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("maps a 503 status to UPSTREAM_UNAVAILABLE", () => {
    expect(normalizeProviderError({ status: 503 }).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("maps an error with no recognizable status to UPSTREAM_UNAVAILABLE (never lets a raw error escape)", () => {
    expect(normalizeProviderError(new Error("some network hiccup")).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(normalizeProviderError("a plain string throw").code).toBe("UPSTREAM_UNAVAILABLE");
    expect(normalizeProviderError(undefined).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("maps signal.aborted to TIMEOUT even if the underlying error looks like a 5xx", () => {
    const controller = new AbortController();
    controller.abort();
    const result = normalizeProviderError({ status: 500 }, controller.signal);
    expect(result.code).toBe("TIMEOUT");
  });

  it("maps an AbortError/TimeoutError by name to TIMEOUT even without a live signal reference", () => {
    expect(normalizeProviderError(new DOMException("aborted", "AbortError")).code).toBe("TIMEOUT");
    expect(normalizeProviderError(new DOMException("timed out", "TimeoutError")).code).toBe("TIMEOUT");
  });

  it("never includes the source error's message in the normalized AppError's message", () => {
    const secret = "sk-super-secret-value-12345";
    const result = normalizeProviderError({ status: 503, message: `request failed for key ${secret}` });
    expect(result.message).not.toContain(secret);
  });

  // A 4xx other than 408/429 means the provider rejected THIS request outright — retrying it
  // against a secondary would never help and would mask a real problem as "always answered by
  // Gemma".
  describe("non-retryable 4xx", () => {
    it.each([410, 401, 400, 404])("marks a %i as UPSTREAM_UNAVAILABLE but NOT retryable", (status) => {
      const result = normalizeProviderError({ status });
      expect(result.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(isRetryableProviderError(result)).toBe(false);
    });

    it("keeps 408 (request timeout) retryable — same bucket as a 5xx", () => {
      const result = normalizeProviderError({ status: 408 });
      expect(result.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(isRetryableProviderError(result)).toBe(true);
    });

    it("keeps a 5xx retryable, unaffected by the 4xx rule", () => {
      expect(isRetryableProviderError(normalizeProviderError({ status: 500 }))).toBe(true);
      expect(isRetryableProviderError(normalizeProviderError({ status: 503 }))).toBe(true);
    });

    it("keeps a 429 (RATE_LIMITED) retryable, unaffected by the 4xx rule", () => {
      expect(isRetryableProviderError(normalizeProviderError({ status: 429 }))).toBe(true);
    });
  });

  it("carries retry-after from a Gemini-shaped RetryInfo in the error message when there are no headers", () => {
    const message = JSON.stringify({
      error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] },
    });
    const result = normalizeProviderError({ status: 429, message });
    expect(result.retryAfterSeconds).toBe(7);
  });

  it("prefers a Headers-based retry-after over a RetryInfo in the message when both are present", () => {
    const headers = new Headers({ "retry-after": "3" });
    const message = JSON.stringify({ error: { details: [{ retryDelay: "99s" }] } });
    const result = normalizeProviderError({ status: 429, headers, message });
    expect(result.retryAfterSeconds).toBe(3);
  });

  it("tags a 429 whose QuotaFailure detail names a PerDay quota id", () => {
    const message = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
              },
            ],
          },
        ],
      },
    });
    expect(isPerDayQuotaError(normalizeProviderError({ status: 429, message }))).toBe(true);
  });

  it("does not tag a 429 with a per-minute RetryInfo and no PerDay quota id", () => {
    const message = JSON.stringify({
      error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] },
    });
    expect(isPerDayQuotaError(normalizeProviderError({ status: 429, message }))).toBe(false);
  });

  it("does not tag a plain 429 with no message", () => {
    expect(isPerDayQuotaError(normalizeProviderError({ status: 429 }))).toBe(false);
  });

  it("isPerDayQuotaError is false for a non-AppError and for an AppError built elsewhere", () => {
    expect(isPerDayQuotaError({ code: "RATE_LIMITED" })).toBe(false);
    expect(isPerDayQuotaError(new AppError("RATE_LIMITED", "x"))).toBe(false);
  });
});

describe("getProviderStatus", () => {
  it("returns the raw HTTP status normalizeProviderError saw, for server-side logging only", () => {
    const result = normalizeProviderError({ status: 410 });
    expect(getProviderStatus(result)).toBe(410);
    // Never surfaced through the message itself.
    expect(result.message).not.toContain("410");
  });

  it("returns undefined for a caller-constructed AppError normalizeProviderError never touched", () => {
    expect(getProviderStatus(new AppError("SCHEMA_FAILED", "x"))).toBeUndefined();
  });

  it("returns undefined for a non-AppError value", () => {
    expect(getProviderStatus({ status: 410 })).toBeUndefined();
  });
});

describe("toStreamErrorEvent", () => {
  it("builds a retryable: true event for a retryable AppError", () => {
    const event = toStreamErrorEvent(normalizeProviderError({ status: 503 }));
    expect(event).toEqual({ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: true });
  });

  it("builds a retryable: false event for a non-retryable 4xx AppError, same code as a 5xx would produce", () => {
    const event = toStreamErrorEvent(normalizeProviderError({ status: 410 }));
    expect(event).toEqual({ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: false });
  });

  it("builds a retryable: false event for SCHEMA_FAILED", () => {
    const event = toStreamErrorEvent(new AppError("SCHEMA_FAILED", "x"));
    expect(event).toEqual({ type: "error", code: "SCHEMA_FAILED", retryable: false });
  });
});

describe("isRetryableProviderErrorCode / isRetryableProviderError", () => {
  it("treats UPSTREAM_UNAVAILABLE, TIMEOUT, RATE_LIMITED as retryable", () => {
    expect(isRetryableProviderErrorCode("UPSTREAM_UNAVAILABLE")).toBe(true);
    expect(isRetryableProviderErrorCode("TIMEOUT")).toBe(true);
    expect(isRetryableProviderErrorCode("RATE_LIMITED")).toBe(true);
  });

  it("treats SCHEMA_FAILED and VALIDATION_FAILED as non-retryable", () => {
    expect(isRetryableProviderErrorCode("SCHEMA_FAILED")).toBe(false);
    expect(isRetryableProviderErrorCode("VALIDATION_FAILED")).toBe(false);
  });

  it("isRetryableProviderError requires an actual AppError instance", () => {
    expect(isRetryableProviderError(new AppError("UPSTREAM_UNAVAILABLE", "x"))).toBe(true);
    expect(isRetryableProviderError({ code: "UPSTREAM_UNAVAILABLE" })).toBe(false);
  });
});

describe("the provider-rejection log line", () => {
  const MARKER = "DOCUMENT-TEXT-MARKER";

  // The one line normalizeProviderError logs for `error`, parsed, plus the raw text of everything logged.
  function logFor(error: unknown, apiKey = "test-key"): { line: unknown; raw: string } {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      normalizeProviderError(error, undefined, { model: "test-model", apiKey });
      const raw = warn.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      return { line: JSON.parse(raw), raw };
    } finally {
      warn.mockRestore();
    }
  }

  it("Gemini: status and the ErrorInfo reason only — never the message (which can quote the request) or other details", () => {
    const body = {
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: `Invalid value at 'contents[0].parts[0].text', "${MARKER}"`,
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" },
          { "@type": "type.googleapis.com/google.rpc.BadRequest", note: `DETAILS-ONLY ${MARKER}` },
        ],
      },
    };

    const { line, raw } = logFor({ status: 400, message: JSON.stringify(body) });

    expect(line).toEqual({
      event: "llm_provider_rejected",
      model: "test-model",
      httpStatus: 400,
      providerStatus: "INVALID_ARGUMENT",
      providerReason: "API_KEY_INVALID",
    });
    expect(raw).not.toContain(MARKER);
    expect(raw).not.toContain("DETAILS-ONLY");
  });

  it("an OpenAI-compatible gateway (NIM/OpenRouter): the error code only — never the message", () => {
    const { line, raw } = logFor({
      status: 400,
      error: { message: `This model's context was exceeded by: ${MARKER}`, code: "context_length_exceeded", type: "invalid_request_error" },
    });

    expect(line).toEqual({
      event: "llm_provider_rejected",
      model: "test-model",
      httpStatus: 400,
      providerStatus: "context_length_exceeded",
      providerReason: null,
    });
    expect(raw).not.toContain(MARKER);
  });

  it("a numeric gateway code is kept; free text put where a code belongs is dropped", () => {
    expect(logFor({ status: 400, error: { message: MARKER, code: 400 } }).line).toMatchObject({ providerStatus: "400" });

    const freeText = logFor({ status: 400, error: { message: "x", code: `Unexpected token near '${MARKER} rent'` } });
    expect(freeText.line).toMatchObject({ providerStatus: null });
    expect(freeText.raw).not.toContain(MARKER);
  });

  it("drops a code that is the call's own API key (exact match, even one no key pattern recognizes) or key-shaped", () => {
    const apiKey = "plainkey123";
    const own = logFor({ status: 401, message: JSON.stringify({ error: { status: apiKey, message: `API key ${apiKey} is invalid.` } }) }, apiKey);
    const shaped = logFor({ status: 401, error: { code: "AIzaSyAnotherKeyThatLooksReal0123456789" } }, apiKey);

    expect(own.line).toMatchObject({ httpStatus: 401, providerStatus: null });
    expect(own.raw).not.toContain(apiKey);
    expect(shaped.line).toMatchObject({ providerStatus: null });
    expect(shaped.raw).not.toContain("AIza");
  });
});
