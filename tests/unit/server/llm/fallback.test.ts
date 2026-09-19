import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { normalizeProviderError } from "@/server/llm/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { FallbackLlmClient } from "@/server/llm/fallback";
import { MIN_FALLBACK_BUDGET_MS } from "@/server/llm/timeouts";
import type { LlmClient } from "@/server/llm/types";

const schema = z.object({ answer: z.string() });

function upstreamUnavailable(): AppError {
  return new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
}

describe("FallbackLlmClient — complete()", () => {
  it("falls back to the secondary on a retryable primary error (503) — modelUsed reflects the secondary", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: upstreamUnavailable() }] });
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ data: { answer: "from secondary" } }] });
    const client = new FallbackLlmClient(primary, secondary);

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(result.data).toEqual({ answer: "from secondary" });
    expect(result.modelUsed).toBe("secondary");
    expect(primary.callCount).toBe(1);
    expect(secondary.callCount).toBe(1);
  });

  it("does NOT fall back on a non-retryable primary error (SCHEMA_FAILED) — the secondary is never called", async () => {
    const primary = new FakeLlmClient({
      modelUsed: "primary",
      responses: ["bad json 1", "bad json 2"].map((rawText) => ({ rawText })),
    });
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ data: { answer: "should never be reached" } }] });
    const client = new FallbackLlmClient(primary, secondary);

    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "SCHEMA_FAILED",
    });
    expect(secondary.callCount).toBe(0);
  });

  // A non-retryable 4xx (dead model, bad auth, a request the provider rejects outright) must never
  // trigger a fallback — retrying the SAME request against a secondary wouldn't help and would mask
  // a real config problem as "always answered by Gemma".
  it.each([410, 401, 400])("does not fall back on a non-retryable 4xx (%i) — the secondary is never called", async (status) => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: normalizeProviderError({ status }) }] });
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ data: { answer: "should never be reached" } }] });
    const client = new FallbackLlmClient(primary, secondary);

    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(secondary.callCount).toBe(0);
  });

  it("throws the typed error and returns NO content when both primary and secondary fail", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: upstreamUnavailable() }] });
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ error: upstreamUnavailable() }] });
    const client = new FallbackLlmClient(primary, secondary);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    } catch (error) {
      caught = error;
    }

    expect(returned).toBeUndefined();
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("does not fall back when the caller's own signal was already aborted — that's cancellation, not an outage", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: upstreamUnavailable() }] });
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ data: { answer: "should never be reached" } }] });
    const client = new FallbackLlmClient(primary, secondary);
    const controller = new AbortController();
    controller.abort();

    // A spy on the METHOD ITSELF, not `secondary.callCount` — FakeLlmClient
    // also refuses an already-aborted signal internally (before recording a
    // call), so `callCount` alone can't tell "fallback correctly skipped"
    // apart from "fallback was attempted but the secondary also bailed
    // early". The spy fires the moment FallbackLlmClient invokes the method,
    // regardless of what happens inside it.
    const secondaryCompleteSpy = vi.spyOn(secondary, "complete");

    await expect(
      client.complete({ systemPrompt: "s", userPrompt: "u", schema, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(secondaryCompleteSpy).not.toHaveBeenCalled();
    expect(secondary.callCount).toBe(0);
  });

  it("rethrows the primary's real error (never a VALIDATION_FAILED) when a native-document input can't be retried against a text-only secondary", async () => {
    const primary = new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      modelUsed: "primary",
      responses: [{ error: upstreamUnavailable() }],
    });
    const secondary = new FakeLlmClient({ capabilities: { nativeDocumentInput: false }, modelUsed: "secondary" });
    const client = new FallbackLlmClient(primary, secondary);

    await expect(
      client.complete({
        systemPrompt: "s",
        userPrompt: "u",
        schema,
        documents: [{ nativeFile: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } }],
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" }); // the primary's real error, not the secondary's VALIDATION_FAILED
    expect(secondary.callCount).toBe(0);
  });

  it("DOES fall back with a native-document input when the secondary also supports it", async () => {
    const primary = new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      modelUsed: "primary",
      responses: [{ error: upstreamUnavailable() }],
    });
    const secondary = new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      modelUsed: "secondary",
      responses: [{ data: { answer: "from secondary" } }],
    });
    const client = new FallbackLlmClient(primary, secondary);

    const result = await client.complete({
      systemPrompt: "s",
      userPrompt: "u",
      schema,
      documents: [{ nativeFile: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } }],
    });
    expect(result.data).toEqual({ answer: "from secondary" });
    expect(result.modelUsed).toBe("secondary");
  });
});

describe("FallbackLlmClient — capabilities", () => {
  it("reports the PRIMARY's own capabilities, not the intersection", () => {
    const primary = new FakeLlmClient({ capabilities: { nativeDocumentInput: true, streaming: true } });
    const secondary = new FakeLlmClient({ capabilities: { nativeDocumentInput: false, streaming: true } });
    const client = new FallbackLlmClient(primary, secondary);

    expect(client.capabilities.structuredOutput).toBe(true);
    // The secondary lacking nativeDocumentInput does NOT make the composite
    // report false — a caller checks capabilities to decide whether to
    // route a document through this client AT ALL, and that decision should
    // track the primary (who serves the overwhelming majority of traffic),
    // not be vetoed by whatever the backup happens to support. The
    // native-document-vs-fallback tension is instead handled per-request
    // (see the "rethrows the primary's real error"/"DOES fall back" tests
    // above).
    expect(client.capabilities.nativeDocumentInput).toBe(true);
    expect(client.capabilities.streaming).toBe(true);
  });

  it("still reports false when the PRIMARY itself lacks a capability, regardless of the secondary", () => {
    const primary = new FakeLlmClient({ capabilities: { nativeDocumentInput: false } });
    const secondary = new FakeLlmClient({ capabilities: { nativeDocumentInput: true } });
    const client = new FallbackLlmClient(primary, secondary);

    expect(client.capabilities.nativeDocumentInput).toBe(false);
  });
});

describe("FallbackLlmClient — stream()", () => {
  it("falls back to the secondary when the primary errors before emitting any token", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: upstreamUnavailable() }] });
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ data: { answer: "from secondary" } }] });
    const client = new FallbackLlmClient(primary, secondary);

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" ? done.modelUsed : undefined).toBe("secondary");
  });

  it("does not fall back on a non-retryable 4xx event either — the secondary is never called", async () => {
    const primary = new FakeLlmClient({ modelUsed: "primary", responses: [{ error: normalizeProviderError({ status: 410 }) }] });
    const secondary = new FakeLlmClient({ modelUsed: "secondary" });
    const client = new FallbackLlmClient(primary, secondary);
    const secondaryStreamSpy = vi.spyOn(secondary, "stream");

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: false }]);
    expect(secondaryStreamSpy).not.toHaveBeenCalled();
  });

  it("does not fall back once the primary has already emitted a token, even though it fails later with a retryable error — never splices two models' output", async () => {
    // The primary genuinely fails (a retryable UPSTREAM_UNAVAILABLE) — but
    // only AFTER already streaming a token from its first (malformed)
    // attempt. This is what makes the assertion below meaningful: if
    // fallback triggered on ANY retryable event (not just a FIRST event with
    // zero tokens emitted), this primary's later failure would (wrongly)
    // trigger a fallback here too.
    const primary = new FakeLlmClient({
      modelUsed: "primary",
      responses: [{ rawText: "not json" }, { error: upstreamUnavailable() }],
    });
    const secondary = new FakeLlmClient({ modelUsed: "secondary" });
    const client = new FallbackLlmClient(primary, secondary);
    const secondaryStreamSpy = vi.spyOn(secondary, "stream");

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "error" && e.retryable)).toBe(true);
    expect(secondaryStreamSpy).not.toHaveBeenCalled();
  });

  it("closes the primary's stream iterator when the consumer stops early", async () => {
    let closed = false;
    const primary: LlmClient = {
      capabilities: { structuredOutput: true, nativeDocumentInput: false, streaming: true },
      complete() {
        throw new Error("not used in this test");
      },
      async *stream() {
        try {
          yield { type: "token", token: "a" };
          yield { type: "token", token: "b" };
        } finally {
          closed = true;
        }
      },
    };
    const secondary = new FakeLlmClient({ modelUsed: "secondary" });
    const client = new FallbackLlmClient(primary, secondary);

    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      expect(event.type).toBe("token"); // sanity: we did get the first event before stopping
      break; // `break` inside `for await...of` calls the iterator's `.return()` — that's what this test proves propagates
    }
    expect(closed).toBe(true);
  });
});

// Measured live: a Gemini timeout cascading through NIM (another 45 s) to OpenRouter's 429 takes
// ~91 s end to end, surfacing only "Too many requests" — hence one budget for the whole chain.
describe("FallbackLlmClient — one budget for the whole chain", () => {
  // A primary that spends `ms` before failing: FakeLlmClient scripts settle immediately.
  function slowFailing(ms: number): LlmClient {
    return {
      capabilities: { structuredOutput: true, nativeDocumentInput: false, streaming: true },
      complete: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        throw upstreamUnavailable();
      },
      stream: () => {
        throw new Error("not used");
      },
    };
  }

  it("a secondary started after the primary failed gets only what is left of the budget, not a fresh one", async () => {
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ data: { answer: "from secondary" } }] });
    const client = new FallbackLlmClient(slowFailing(200), secondary);

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema, timeoutMs: 60_000 });

    expect(result.modelUsed).toBe("secondary");
    const given = secondary.calls[0].timeoutMs!;
    expect(given).toBeLessThanOrEqual(60_000 - 190);
    expect(given).toBeGreaterThan(60_000 - 5_000);
  });

  it("a primary that used up the budget: the secondary is never started, and the primary's TIMEOUT surfaces", async () => {
    const primary = new FakeLlmClient({ responses: [{ hang: true }] });
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "must never be asked" } } });
    const client = new FallbackLlmClient(primary, secondary);

    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema, timeoutMs: 50 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(secondary.callCount).toBe(0);
  });

  it("stream(): a primary that used up the budget yields its own TIMEOUT, and the secondary is never started", async () => {
    const primary = new FakeLlmClient({ responses: [{ hang: true }] });
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "must never be asked" } } });
    const client = new FallbackLlmClient(primary, secondary);

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema, timeoutMs: 50 })) events.push(event);

    expect(events).toEqual([{ type: "error", code: "TIMEOUT", retryable: true }]);
    expect(secondary.callCount).toBe(0);
  });

  it(`a fast primary failure with less than MIN_FALLBACK_BUDGET_MS (${MIN_FALLBACK_BUDGET_MS} ms) left: the secondary is not started`, async () => {
    const primaryError = upstreamUnavailable();
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "must never be asked" } } });
    const client = new FallbackLlmClient(new FakeLlmClient({ responses: [{ error: primaryError }] }), secondary);

    const budget = MIN_FALLBACK_BUDGET_MS - 5_000;
    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema, timeoutMs: budget })).rejects.toBe(primaryError);
    expect(secondary.callCount).toBe(0);
  });

  it("stream(): a fast primary failure with less than MIN_FALLBACK_BUDGET_MS left yields the primary's error, secondary not started", async () => {
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "must never be asked" } } });
    const client = new FallbackLlmClient(new FakeLlmClient({ responses: [{ error: upstreamUnavailable() }] }), secondary);

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema, timeoutMs: MIN_FALLBACK_BUDGET_MS - 5_000 })) events.push(event);

    expect(events).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: true }]);
    expect(secondary.callCount).toBe(0);
  });

  it("with no budget set, the secondary is called as before, with no timeoutMs of its own", async () => {
    const primary = new FakeLlmClient({ responses: [{ error: upstreamUnavailable() }] });
    const secondary = new FakeLlmClient({ modelUsed: "secondary", responses: [{ data: { answer: "ok" } }] });

    await new FallbackLlmClient(primary, secondary).complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(secondary.calls[0].timeoutMs).toBeUndefined();
  });
});

describe("FallbackLlmClient — when both fail, the real cause surfaces", () => {
  const timeout = () => new AppError("TIMEOUT", safeMessageFor("TIMEOUT"));
  // A provider's own 429, exactly as the adapters produce it (tagged with the HTTP status).
  const provider429 = () => normalizeProviderError({ status: 429, message: "quota" });
  // Our own limiter's RATE_LIMITED: untagged, with a retry-after.
  const ownLimiter = () => new AppError("RATE_LIMITED", safeMessageFor("RATE_LIMITED"), { retryAfterSeconds: 30 });
  const schemaFailed = () => new AppError("SCHEMA_FAILED", safeMessageFor("SCHEMA_FAILED"));

  async function completeError(primaryError: AppError, secondaryError: AppError): Promise<unknown> {
    const client = new FallbackLlmClient(
      new FakeLlmClient({ responses: [{ error: primaryError }] }),
      new FakeLlmClient({ responses: [{ error: secondaryError }] }),
    );
    try {
      await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    } catch (error) {
      return error;
    }
    throw new Error("expected a rejection");
  }

  async function streamEvents(primaryError: AppError, secondaryError: AppError) {
    const client = new FallbackLlmClient(
      new FakeLlmClient({ responses: [{ error: primaryError }] }),
      new FakeLlmClient({ responses: [{ error: secondaryError }] }),
    );
    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) events.push(event);
    return events;
  }

  const cases: [string, () => AppError, () => AppError, "primary" | "secondary"][] = [
    ["primary TIMEOUT, secondary provider 429 -> the primary's TIMEOUT", timeout, provider429, "primary"],
    ["primary UPSTREAM (503), secondary TIMEOUT -> the primary's UPSTREAM_UNAVAILABLE", upstreamUnavailable, timeout, "primary"],
    ["primary UPSTREAM (5xx), secondary provider 429 -> the primary's UPSTREAM_UNAVAILABLE", upstreamUnavailable, provider429, "primary"],
    ["primary TIMEOUT, secondary blocked by OUR limiter -> that RATE_LIMITED, retry-after intact", timeout, ownLimiter, "secondary"],
    ["primary UPSTREAM, secondary blocked by OUR limiter -> that RATE_LIMITED, retry-after intact", upstreamUnavailable, ownLimiter, "secondary"],
    ["primary TIMEOUT, secondary answered unusably -> the secondary's SCHEMA_FAILED", timeout, schemaFailed, "secondary"],
  ];

  it.each(cases)("complete(): %s", async (_name, primaryError, secondaryError, surfaces) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const primary = primaryError();
      const secondary = secondaryError();
      const caught = await completeError(primary, secondary);
      expect(caught).toBe(surfaces === "primary" ? primary : secondary);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(cases)("stream(): %s", async (_name, primaryError, secondaryError, surfaces) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const primary = primaryError();
      const secondary = secondaryError();
      const events = await streamEvents(primary, secondary);
      const expected = surfaces === "primary" ? primary : secondary;
      expect(events).toEqual([{ type: "error", code: expected.code, retryable: expect.any(Boolean) }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("our own limiter's RATE_LIMITED keeps its retry-after through complete()", async () => {
    const caught = await completeError(timeout(), ownLimiter());
    expect(caught).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 30 });
  });

  it("stream(): a secondary that streamed tokens and then failed at the provider still surfaces the primary's cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = new FallbackLlmClient(
        new FakeLlmClient({ responses: [{ error: timeout() }] }),
        new FakeLlmClient({ responses: [{ rawText: "not json" }, { error: provider429() }] }),
      );
      const events = [];
      for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) events.push(event);
      expect(events.at(-1)).toEqual({ type: "error", code: "TIMEOUT", retryable: true });
      expect(events.slice(0, -1).every((event) => event.type === "token")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
