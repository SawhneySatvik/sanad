import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "@tests/support/db";
import { ConfigError } from "@/server/core/env";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { FallbackLlmClient } from "@/server/llm/fallback";
import { normalizeProviderError } from "@/server/llm/errors";
import { checkGlobalLimit, DEFAULT_GLOBAL_LIMIT, MAX_HTTP_ATTEMPTS_PER_CALL, type Clock } from "@/server/rate-limit/limiter";
import { withGlobalLimit } from "@/server/rate-limit/with-global-limit";

const schema = z.object({ answer: z.string() });

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

function fixedClock(iso: string): Clock {
  const date = new Date(iso);
  return { now: () => date };
}

describe("withGlobalLimit — complete()", () => {
  it("under the limit: inner is called exactly once, result (including modelUsed) passes through unchanged", async () => {
    const inner = new FakeLlmClient({ modelUsed: "gemini-2.0-flash", responses: [{ data: { answer: "hi" } }] });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 5, clock: fixedClock("2026-09-23T10:00:00.000Z") });

    const result = await limited.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(inner.callCount).toBe(1);
    expect(result.data).toEqual({ answer: "hi" });
    expect(result.modelUsed).toBe("gemini-2.0-flash");
  });

  it("over the limit: throws RATE_LIMITED and inner's call count stays EXACTLY 0 (fail fast, never call inner)", async () => {
    // Fill the bucket directly (not through the decorator) so this is a single call through
    // `limited`, isolating the "over limit" case from any "first call was allowed" call count.
    const clock = fixedClock("2026-09-23T11:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock });

    const inner = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 1, clock });

    await expect(limited.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    expect(inner.callCount).toBe(0);
  });

  it("capabilities pass through from the inner client unchanged", () => {
    const inner = new FakeLlmClient({ capabilities: { nativeDocumentInput: true, streaming: false } });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemma", limit: 5 });
    expect(limited.capabilities).toEqual(inner.capabilities);
  });

  it("provider buckets are independent: gemini's limit doesn't affect gemma's", async () => {
    const clock = fixedClock("2026-09-23T12:00:00.000Z");
    const geminiInner = new FakeLlmClient({ responses: [{ data: { answer: "g" } }] });
    const gemmaInner = new FakeLlmClient({ responses: [{ data: { answer: "m" } }] });
    const geminiLimited = withGlobalLimit(geminiInner, { db: t.db, providerKey: "gemini", limit: 1, clock });
    const gemmaLimited = withGlobalLimit(gemmaInner, { db: t.db, providerKey: "gemma", limit: 1, clock });

    await geminiLimited.complete({ systemPrompt: "s", userPrompt: "u", schema });
    await expect(gemmaLimited.complete({ systemPrompt: "s", userPrompt: "u", schema })).resolves.toMatchObject({
      data: { answer: "m" },
    });
  });
});

describe("withGlobalLimit — stream()", () => {
  it("under the limit: inner.stream() is called, events pass through, callCount is 1", async () => {
    const inner = new FakeLlmClient({ modelUsed: "gemma-nim", responses: [{ data: { answer: "streamed" } }] });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemma", limit: 5, clock: fixedClock("2026-09-23T13:00:00.000Z") });

    const events = [];
    for await (const event of limited.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }

    expect(inner.callCount).toBe(1);
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ modelUsed: "gemma-nim", data: { answer: "streamed" } });
  });

  it("over the limit: yields an error event (never throws) and inner's call count stays EXACTLY 0", async () => {
    const clock = fixedClock("2026-09-23T14:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock }); // fills the bucket directly

    const inner = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 1, clock });

    const events = [];
    for await (const event of limited.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }

    // retryable: true — RATE_LIMITED is retryable (src/server/llm/errors.ts), which is exactly
    // what lets FallbackLlmClient.stream() (composed test below) still try a secondary.
    expect(events).toEqual([{ type: "error", code: "RATE_LIMITED", retryable: true }]);
    expect(inner.callCount).toBe(0);
  });
});

// Backs the design decision to yield an error EVENT from stream() rather than throw:
// FallbackLlmClient.stream() only inspects the first yielded event to decide whether to fall back, so
// a global-limit trip on the primary must still let the secondary answer, on both complete()/stream().
describe("withGlobalLimit composed inside FallbackLlmClient — quota trip on primary still falls back to secondary", () => {
  it("complete(): primary's bucket is full -> secondary answers, primary never called", async () => {
    const clock = fixedClock("2026-09-23T15:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock }); // fill gemini's bucket

    const primary = new FakeLlmClient({ defaultResponse: { data: { answer: "primary should never answer" } } });
    const secondary = new FakeLlmClient({ modelUsed: "gemma", responses: [{ data: { answer: "from secondary" } }] });
    const client = new FallbackLlmClient(
      withGlobalLimit(primary, { db: t.db, providerKey: "gemini", limit: 1, clock }),
      secondary,
    );

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(result.data).toEqual({ answer: "from secondary" });
    expect(result.modelUsed).toBe("gemma");
    expect(primary.callCount).toBe(0);
    expect(secondary.callCount).toBe(1);
  });

  it("stream(): primary's bucket is full -> secondary's stream answers, primary never called", async () => {
    const clock = fixedClock("2026-09-23T16:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock });

    const primary = new FakeLlmClient({ defaultResponse: { data: { answer: "primary should never answer" } } });
    const secondary = new FakeLlmClient({ modelUsed: "gemma", responses: [{ data: { answer: "streamed from secondary" } }] });
    const client = new FallbackLlmClient(
      withGlobalLimit(primary, { db: t.db, providerKey: "gemini", limit: 1, clock }),
      secondary,
    );

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ modelUsed: "gemma", data: { answer: "streamed from secondary" } });
    expect(primary.callCount).toBe(0);
    expect(secondary.callCount).toBe(1);
  });
});

// Sanity check that this decorator's AppError is the same RATE_LIMITED shape the rest of the
// codebase produces (safeMessageFor), not an ad hoc message string.
describe("withGlobalLimit — error message shape", () => {
  it("the thrown AppError uses the shared safeMessageFor(\"RATE_LIMITED\") text", async () => {
    const clock = fixedClock("2026-09-23T17:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock });
    const inner = new FakeLlmClient({ defaultResponse: { data: { answer: "x" } } });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 1, clock });

    let caught: unknown;
    try {
      await limited.complete({ systemPrompt: "s", userPrompt: "u", schema });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toBe(safeMessageFor("RATE_LIMITED"));
  });
});

// `opts.limit` is validated at construction, not lazily on first use — a misconfigured decorator
// must fail at startup/composition time.
describe("withGlobalLimit — opts.limit validated at construction", () => {
  it.each([0, -1, 1.5, NaN, Infinity])("throws a typed ConfigError immediately for opts.limit = %s, without needing a call", (bad) => {
    const inner = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    expect(() => withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: bad })).toThrow(ConfigError);
    expect(inner.callCount).toBe(0); // never even got the chance to be called
  });

  it("accepts a valid positive integer limit", () => {
    const inner = new FakeLlmClient();
    expect(() => withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 5 })).not.toThrow();
  });
});

// The decorator must pass inner errors/events through unchanged — same object reference for a thrown
// error, same shape for a stream event — never re-wrap/re-create them. Rebuilding would silently lose
// the WeakSet-based non-retryable marking (errors.ts) that stops a 410 from triggering a silent retry.
describe("withGlobalLimit — inner errors/events pass through UNCHANGED, never rewrapped", () => {
  it("complete(): a non-RATE_LIMITED error from inner propagates as the EXACT SAME error object", async () => {
    const originalError = normalizeProviderError({ status: 410 }); // real WeakSet-marked non-retryable instance
    const inner = new FakeLlmClient({ responses: [{ error: originalError }] });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 5 });

    let caught: unknown;
    try {
      await limited.complete({ systemPrompt: "s", userPrompt: "u", schema });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(originalError); // reference equality, not just deep-equal fields
  });

  it("stream(): a non-retryable inner error event (410) passes through with retryable:false preserved, unmodified", async () => {
    const nonRetryableError = normalizeProviderError({ status: 410 });
    const inner = new FakeLlmClient({ responses: [{ error: nonRetryableError }] });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 5 });

    const events = [];
    for await (const event of limited.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: false }]);
  });

  it("stream(): a RETRYABLE inner error event (503) also passes through untouched, for contrast", async () => {
    const retryableError = normalizeProviderError({ status: 503 });
    const inner = new FakeLlmClient({ responses: [{ error: retryableError }] });
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", limit: 5 });

    const events = [];
    for await (const event of limited.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: true }]);
  });
});

// The global bucket counts LlmClient-level calls, but ONE call can make up to
// MAX_HTTP_ATTEMPTS_PER_CALL real HTTP requests via the schema-repair retry. Proves the default
// limit's arithmetic (floor(assumedRpm / MAX_HTTP_ATTEMPTS_PER_CALL)) holds the real HTTP rate.
describe("withGlobalLimit — MAX_HTTP_ATTEMPTS_PER_CALL-aware default", () => {
  it("at the default Gemini setting, a burst can't exceed the assumed provider quota in HTTP requests", async () => {
    let attempts = 0;
    const inner = new FakeLlmClient({
      // Always unparseable -> completeStructured (structured-output.ts) exhausts the FULL
      // MAX_ATTEMPTS budget (original + 1 repair retry) on every admitted call, never succeeding
      // early — this is what makes `attempts` an honest worst-case HTTP-request-count proxy.
      defaultResponse: () => {
        attempts++;
        return { rawText: "not json" };
      },
    });
    const clock = fixedClock("2026-09-23T18:00:00.000Z");
    // No `limit` override -> resolves DEFAULT_GLOBAL_LIMIT.gemini, exactly what a real deployment
    // with no env override would use.
    const limited = withGlobalLimit(inner, { db: t.db, providerKey: "gemini", clock });

    const burstSize = DEFAULT_GLOBAL_LIMIT.gemini * 3;
    await Promise.allSettled(
      Array.from({ length: burstSize }, () => limited.complete({ systemPrompt: "s", userPrompt: "u", schema })),
    );

    // Every admitted call exhausts exactly MAX_HTTP_ATTEMPTS_PER_CALL attempts (SCHEMA_FAILED
    // after the bounded repair retry); rejected (over-limit) calls contribute 0.
    expect(attempts).toBe(DEFAULT_GLOBAL_LIMIT.gemini * MAX_HTTP_ATTEMPTS_PER_CALL);
    // The real point of this test: that total never exceeds the assumed provider quota (mirrors
    // limiter.ts's private GEMINI_ASSUMED_RPM = 15 — not exported, since no other module needs the
    // raw assumed-RPM number, only the derived call-level limit).
    expect(attempts).toBeLessThanOrEqual(15);
  });
});
