// Shared LlmClient contract suite. Every adapter's own *.test.ts file calls
// `runLlmContract(name, makeHarness)` once, so FakeLlmClient, GeminiLlmClient and GemmaLlmClient
// are all proven to satisfy the exact same behavior, not three independent approximations of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import https from "node:https";
import { z } from "zod";
import { AppError } from "@/server/core/errors";
import { isRetryableProviderError } from "@/server/llm/errors";
import type { LlmClient } from "@/server/llm/types";

/** The (fake) API key every harness's client is built with; "never leaks the key" asserts against it. */
export const HARNESS_SECRET_API_KEY = "test-secret-api-key-do-not-leak";

const schema = z.object({ answer: z.string() });

/** What a concrete adapter's own `*.test.ts` supplies to run the shared LlmClient contract against it. */
export interface ContractHarness {
  client: LlmClient;
  // The client under test was constructed with this as its (fake) API key —
  // used only by the "never leaks the key" test to assert it never appears
  // in a thrown error's message.
  secretApiKey: string;
  // Queues what the NEXT provider attempt returns/does. Each of `queueText`/`queueError`/
  // `queueHang` may be called multiple times to script a sequence of attempts (e.g. malformed
  // JSON, then valid JSON, for the repair-retry tests).
  queueText(rawText: string): void;
  // `retryAfterSeconds`, when given, must be recoverable by the adapter under test through
  // whatever real, provider-shaped channel it actually uses (an HTTP `retry-after` header, or
  // Gemini SDK's `google.rpc.RetryInfo.retryDelay` in the body) — no harness may skip this.
  queueError(status: number, retryAfterSeconds?: number): void;
  queueHang(): void;
}

// Deliberately NOT named `*.test.ts` — it calls `describe`/`it` itself, so importing it from a
// `*.test.ts` file registers the suite, but vitest's `include` glob only picks up `.test.ts`
// files, so this module is never collected as its own (empty) suite.
export function runLlmContract(name: string, makeHarness: () => ContractHarness): void {
  describe(`LlmClient contract — ${name}`, () => {
    // Structural proof this suite never reaches a live host: a network-call spy that fails the
    // test if one fires, independent of tests/setup/no-network.ts's own fetch/http-boundary guard
    // — catches an adapter that forgets to use its injected transport even if that guard weakens.
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let httpsRequestSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
      httpsRequestSpy = vi.spyOn(https, "request");
    });

    afterEach(() => {
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpsRequestSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      httpsRequestSpy.mockRestore();
    });

    it("exposes capabilities.structuredOutput: true", () => {
      expect(makeHarness().client.capabilities.structuredOutput).toBe(true);
    });

    it("complete() returns data validated against the schema, a modelUsed string, and tokensUsed from that one attempt", async () => {
      const h = makeHarness();
      // Every harness's `queueText` embeds a known, fixed {input:1, output:1} usage per provider
      // attempt — asserting the EXACT total (not just ">= 0") is what catches an adapter that
      // silently hardcodes or drops usage instead of reading it off the response.
      h.queueText(JSON.stringify({ answer: "ok" }));
      const result = await h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema });
      expect(result.data).toEqual({ answer: "ok" });
      expect(typeof result.modelUsed).toBe("string");
      expect(result.modelUsed.length).toBeGreaterThan(0);
      expect(result.tokensUsed).toEqual({ input: 1, output: 1 });
    });

    it("repairs once on malformed JSON, then succeeds — exactly 2 provider attempts, tokensUsed summed across both", async () => {
      const h = makeHarness();
      h.queueText("this is not json");
      h.queueText(JSON.stringify({ answer: "fixed" }));
      const result = await h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema });
      expect(result.data).toEqual({ answer: "fixed" });
      expect(result.tokensUsed).toEqual({ input: 2, output: 2 });
    });

    it("repairs once on schema-mismatched JSON, then succeeds", async () => {
      const h = makeHarness();
      h.queueText(JSON.stringify({ wrongField: "shape" }));
      h.queueText(JSON.stringify({ answer: "fixed" }));
      const result = await h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema });
      expect(result.data).toEqual({ answer: "fixed" });
    });

    it("throws SCHEMA_FAILED after exactly one repair retry still fails — never a third attempt", async () => {
      const h = makeHarness();
      h.queueText("still not json");
      h.queueText("also still not json");
      // A THIRD queued item that WOULD succeed proves the bound is exactly
      // one repair retry — if the adapter tried again, this test would
      // observe a success instead of SCHEMA_FAILED.
      h.queueText(JSON.stringify({ answer: "should never be reached" }));
      await expect(h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema })).rejects.toMatchObject({
        code: "SCHEMA_FAILED",
      });
    });

    it("normalizes a 429 to RATE_LIMITED", async () => {
      const h = makeHarness();
      h.queueError(429, 12);
      await expect(h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema })).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
    });

    it("normalizes a 503 to UPSTREAM_UNAVAILABLE", async () => {
      const h = makeHarness();
      h.queueError(503);
      await expect(h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema })).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
    });

    it("normalizes an abort/timeout to TIMEOUT", async () => {
      const h = makeHarness();
      h.queueHang();
      await expect(
        h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema, timeoutMs: 20 }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
    });

    // Closed end-to-end through each real adapter (not just errors.ts in isolation) — a 410 (dead
    // model / bad config) must never be retryable, so FallbackLlmClient never masks it as "always
    // answered by Gemma".
    it("normalizes a 410 to UPSTREAM_UNAVAILABLE but marks it non-retryable", async () => {
      const h = makeHarness();
      h.queueError(410);
      let caught: unknown;
      try {
        await h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(isRetryableProviderError(caught)).toBe(false);
    });

    it("never includes the API key in a thrown error's message", async () => {
      const h = makeHarness();
      h.queueError(500);
      let caught: unknown;
      try {
        await h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).message).not.toContain(h.secretApiKey);
    });

    it("stream() emits token events before a done event carrying validated data", async () => {
      const h = makeHarness();
      h.queueText(JSON.stringify({ answer: "streamed" }));
      const events = [];
      for await (const event of h.client.stream({ systemPrompt: "sys", userPrompt: "user", schema })) {
        events.push(event);
      }
      const doneIndex = events.findIndex((e) => e.type === "done");
      expect(doneIndex).toBeGreaterThanOrEqual(0);
      // Every event before "done" is a "token" — no badge/data appears before
      // the stream completes and validation has run.
      expect(events.slice(0, doneIndex).every((e) => e.type === "token")).toBe(true);
      const done = events[doneIndex];
      if (done.type === "done") {
        expect(done.data).toEqual({ answer: "streamed" });
        expect(typeof done.modelUsed).toBe("string");
        // Same exact-usage rationale as complete()'s test above — a streamed
        // response's tokensUsed must come from the provider's own usage
        // data, never a hardcoded placeholder.
        expect(done.tokensUsed).toEqual({ input: 1, output: 1 });
      }
    });

    it("stream() emits an error event and never a done event on provider failure", async () => {
      const h = makeHarness();
      h.queueError(503);
      const events = [];
      for await (const event of h.client.stream({ systemPrompt: "sys", userPrompt: "user", schema })) {
        events.push(event);
      }
      expect(events.some((e) => e.type === "error" && e.code === "UPSTREAM_UNAVAILABLE" && e.retryable)).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(false);
    });

    it("stream() marks a 410 error event as retryable: false", async () => {
      const h = makeHarness();
      h.queueError(410);
      const events = [];
      for await (const event of h.client.stream({ systemPrompt: "sys", userPrompt: "user", schema })) {
        events.push(event);
      }
      expect(events).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: false }]);
    });

    it("stream() emits tokens from the FIRST attempt, then SCHEMA_FAILED (no done) when the repair retry also fails", async () => {
      const h = makeHarness();
      h.queueText("still not json");
      h.queueText("also still not json");
      const events = [];
      for await (const event of h.client.stream({ systemPrompt: "sys", userPrompt: "user", schema })) {
        events.push(event);
      }
      expect(events.some((e) => e.type === "token")).toBe(true);
      expect(events.some((e) => e.type === "error" && e.code === "SCHEMA_FAILED" && !e.retryable)).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(false);
    });

    it("stream() emits tokens from the FIRST attempt, then a done event carrying the REPAIRED data (exercises the real repair round-trip)", async () => {
      const h = makeHarness();
      h.queueText("not json");
      h.queueText(JSON.stringify({ answer: "fixed" }));
      const events = [];
      for await (const event of h.client.stream({ systemPrompt: "sys", userPrompt: "user", schema })) {
        events.push(event);
      }
      expect(events.some((e) => e.type === "token")).toBe(true);
      const done = events.find((e) => e.type === "done");
      expect(done && done.type === "done" ? done.data : undefined).toEqual({ answer: "fixed" });
    });

    it("stream() emits TIMEOUT (retryable) and no done event on a hang", async () => {
      const h = makeHarness();
      h.queueHang();
      const events = [];
      for await (const event of h.client.stream({
        systemPrompt: "sys",
        userPrompt: "user",
        schema,
        timeoutMs: 20,
      })) {
        events.push(event);
      }
      expect(events.some((e) => e.type === "error" && e.code === "TIMEOUT" && e.retryable)).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(false);
    });

    // The model's raw output is never trusted to only contain what the schema declares.
    it("strips a status/quote_span_* field the model added alongside the schema's own key — result has ONLY the schema's keys", async () => {
      const h = makeHarness();
      h.queueText(JSON.stringify({ answer: "ok", status: "verified", quote_span_start: 0, quote_span_end: 2 }));
      const result = await h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema });
      expect(result.data).toStrictEqual({ answer: "ok" });
    });

    it("rejects a schema that itself declares a forbidden key — complete() throws before any provider call", async () => {
      const h = makeHarness();
      const forbiddenSchema = z.object({ answer: z.string(), status: z.string() });
      // Queue a response that WOULD satisfy `forbiddenSchema` if the guard didn't run — without
      // this, an unguarded call could throw for an unrelated reason and the assertion below would
      // pass for the wrong reason. Matching the guard's own message proves its check fired.
      h.queueText(JSON.stringify({ answer: "ok", status: "verified" }));
      await expect(
        h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema: forbiddenSchema }),
      ).rejects.toThrow(/forbidden key/);
    });

    it("rejects a permissive (looseObject) schema in stream() too — ZERO events are ever emitted", async () => {
      const h = makeHarness();
      const permissiveSchema = z.looseObject({ answer: z.string() });
      // Same rationale as above: a response that WOULD stream/validate fine
      // under `permissiveSchema` if the guard didn't run first.
      h.queueText(JSON.stringify({ answer: "ok" }));
      const events: unknown[] = [];
      await expect(
        (async () => {
          for await (const event of h.client.stream({
            systemPrompt: "sys",
            userPrompt: "user",
            schema: permissiveSchema,
          })) {
            events.push(event);
          }
        })(),
      ).rejects.toThrow(/additionalProperties/);
      expect(events).toHaveLength(0);
    });

    // Gemini's SDK exposes no response headers on its ApiError — it embeds a
    // `google.rpc.RetryInfo` in the JSON error body instead. Every harness must recover
    // `retryAfterSeconds` through whichever real channel its adapter actually uses.
    it("carries retry-after through a 429 when the provider sends one", async () => {
      const h = makeHarness();
      h.queueError(429, 12);
      let caught: unknown;
      try {
        await h.client.complete({ systemPrompt: "sys", userPrompt: "user", schema });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).retryAfterSeconds).toBe(12);
    });
  });
}
