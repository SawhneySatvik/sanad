import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { safeMessageFor } from "@/server/core/errors";
import { type ContractHarness, HARNESS_SECRET_API_KEY, runLlmContract } from "@tests/support/contracts/llm-client";
import { isRetryableProviderError } from "@/server/llm/errors";
import { type GeminiGenerateResult, type GeminiModelsTransport, GeminiLlmClient } from "@/server/llm/gemini";

const schema = z.object({ answer: z.string() });

// A fake at the exact SDK boundary this adapter calls
// (`GoogleGenAI(...).models.generateContent`/`.generateContentStream`) — see
// gemini.ts's `GeminiModelsTransport`. Response shapes mirror the real
// @google/genai `GenerateContentResponse` (`.text`, `.usageMetadata`).
function makeFakeTransport() {
  const queue: Array<() => Promise<GeminiGenerateResult>> = [];
  const enqueue = (thunk: () => Promise<GeminiGenerateResult>) => queue.push(thunk);

  function watchAbort(signal: AbortSignal | undefined): Promise<never> {
    return new Promise((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    });
  }

  const transport: GeminiModelsTransport = {
    async generateContent(params) {
      const next = queue.shift();
      if (!next) throw new Error("test harness: no response queued");
      // `config.abortSignal` mirrors the real SDK's own abort wiring — a
      // queued "hang" thunk below races this to simulate a stalled request.
      return Promise.race([next(), watchAbort(params.config?.abortSignal)]);
    },
    async generateContentStream(params) {
      const next = queue.shift();
      if (!next) throw new Error("test harness: no response queued");
      const result = await Promise.race([next(), watchAbort(params.config?.abortSignal)]);
      return (async function* () {
        yield result;
      })();
    },
  };

  return { transport, enqueue };
}

function makeGeminiHarness(): ContractHarness {
  const { transport, enqueue } = makeFakeTransport();
  const client = new GeminiLlmClient({ apiKey: HARNESS_SECRET_API_KEY, transport });
  return {
    client,
    secretApiKey: HARNESS_SECRET_API_KEY,
    queueText: (rawText) =>
      enqueue(async () => ({ text: rawText, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })),
    queueError: (status, retryAfterSeconds) =>
      // Realistic shape: @google/genai's `ApiError.message` is
      // `JSON.stringify(errorBody)` — the raw parsed response body (see
      // node_modules/@google/genai/dist/node/index.mjs's
      // `throwErrorIfNotOK`), which for a 429 typically embeds a
      // `google.rpc.RetryInfo`. The SDK sends the API key via the
      // `x-goog-api-key` request header for these REST calls, not the URL —
      // this harness embeds the fake key directly in the body instead, as
      // the stand-in for "some request/response detail that must never
      // reach a thrown AppError's message."
      enqueue(async () => {
        throw {
          status,
          message: JSON.stringify({
            error: {
              code: status,
              message: `simulated failure (key=${HARNESS_SECRET_API_KEY})`,
              status: status === 429 ? "RESOURCE_EXHAUSTED" : "UNKNOWN",
              ...(retryAfterSeconds !== undefined
                ? { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${retryAfterSeconds}s` }] }
                : {}),
            },
          }),
        };
      }),
    queueHang: () => enqueue(() => new Promise<GeminiGenerateResult>(() => {})),
  };
}

runLlmContract("GeminiLlmClient", makeGeminiHarness);

describe("GeminiLlmClient — Gemini-specific behavior", () => {
  it("has capabilities.nativeDocumentInput: true and capabilities.streaming: true", () => {
    const { client } = makeGeminiHarness();
    expect(client.capabilities.nativeDocumentInput).toBe(true);
    expect(client.capabilities.streaming).toBe(true);
  });

  it("sends the system prompt as systemInstruction and encodes a nativeFile document as base64 inlineData", async () => {
    const queue: unknown[] = [];
    const transport: GeminiModelsTransport = {
      generateContent: async (params) => {
        queue.push(params);
        return { text: JSON.stringify({ answer: "ok" }), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      },
      generateContentStream: async () => (async function* () {})(),
    };
    const client = new GeminiLlmClient({ apiKey: "k", transport });
    const bytes = new Uint8Array([1, 2, 3]);
    await client.complete({
      systemPrompt: "you are a lawyer",
      userPrompt: "analyze this",
      schema,
      documents: [{ nativeFile: { bytes, mimeType: "application/pdf" } }],
    });

    expect(queue).toHaveLength(1);
    const sent = queue[0] as { config?: { systemInstruction?: unknown }; contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(sent.config?.systemInstruction).toBe("you are a lawyer");
    const parts = sent.contents[0].parts;
    expect(parts.some((p) => p.text === "analyze this")).toBe(true);
    const inlinePart = parts.find((p) => "inlineData" in p) as { inlineData: { mimeType: string; data: string } } | undefined;
    expect(inlinePart?.inlineData.mimeType).toBe("application/pdf");
    expect(inlinePart?.inlineData.data).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("sends responseJsonSchema derived from the zod schema, without a $schema key (Gemini rejects it)", async () => {
    const queue: unknown[] = [];
    const transport: GeminiModelsTransport = {
      generateContent: async (params) => {
        queue.push(params);
        return { text: JSON.stringify({ answer: "ok" }), usageMetadata: {} };
      },
      generateContentStream: async () => (async function* () {})(),
    };
    const client = new GeminiLlmClient({ apiKey: "k", transport });
    await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    const sent = queue[0] as { config: { responseJsonSchema: Record<string, unknown>; responseMimeType: string } };
    expect(sent.config.responseMimeType).toBe("application/json");
    expect(sent.config.responseJsonSchema).not.toHaveProperty("$schema");
    expect(sent.config.responseJsonSchema.type).toBe("object");
  });

  // Exercises the default transport builder itself, via `@google/genai`'s own injectable-fetch
  // constructor option — never touches `globalThis.fetch`, so the no-network guard never sees it,
  // and it is the only way to prove the default transport's `retryOptions: { attempts: 1 }` took effect.
  it("the default transport makes exactly 1 HTTP attempt on a 429 — no SDK-level retry", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      const body = JSON.stringify({
        error: {
          code: 429,
          message: "Resource exhausted",
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }],
        },
      });
      return new Response(body, { status: 429, headers: { "content-type": "application/json" } });
    };
    const client = new GeminiLlmClient({ apiKey: "k", fetch: fakeFetch });

    let caught: unknown;
    try {
      await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    } catch (error) {
      caught = error;
    }

    expect(calls).toBe(1);
    expect(caught).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 7 });
  });

  // A call that never passes its own `timeoutMs` must still be bounded by the client's
  // `defaultTimeoutMs`, so no call can hang for the SDK's unbounded default — a distinct code path
  // from `input.timeoutMs`, covered by the shared contract suite's own timeout test.
  it("bounds a call with no per-call timeoutMs using the client's defaultTimeoutMs", async () => {
    // Respects `config.abortSignal` the same way a real fetch-based
    // transport would — a transport that ignored it entirely would hang
    // forever regardless of any timeout value, which isn't what this test
    // is checking (that's a transport-implementation concern, not this
    // adapter's `defaultTimeoutMs` wiring).
    const transport: GeminiModelsTransport = {
      generateContent: (params) =>
        new Promise((_resolve, reject) => {
          params.config?.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        }),
      generateContentStream: () => new Promise(() => {}),
    };
    const client = new GeminiLlmClient({ apiKey: "k", transport, defaultTimeoutMs: 20 });
    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});

describe("the schema Gemini is sent, and what a rejected call logs", () => {
  it("sends responseJsonSchema without maxItems or $schema (complete and stream), while zod still rejects an over-cap answer", async () => {
    const capped = z.object({ items: z.array(z.string()).max(3) });
    expect(JSON.stringify(z.toJSONSchema(capped))).toContain('"maxItems":3');
    const sent: GenerateContentParameters[] = [];
    const overCap = { text: JSON.stringify({ items: ["a", "b", "c", "d"] }), usageMetadata: {} };
    const transport: GeminiModelsTransport = {
      generateContent: async (params) => {
        sent.push(params);
        return overCap;
      },
      generateContentStream: async (params) => {
        sent.push(params);
        return (async function* () {
          yield overCap;
        })();
      },
    };
    const client = new GeminiLlmClient({ apiKey: "k", transport });

    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema: capped })).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    const events: unknown[] = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema: capped })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "SCHEMA_FAILED" });

    // complete(): original + repair; stream(): streamed original + non-streamed repair.
    expect(sent).toHaveLength(4);
    for (const params of sent) {
      const wire = JSON.stringify(params.config?.responseJsonSchema);
      expect(wire).toContain('"items"');
      expect(wire).not.toContain("maxItems");
      expect(wire).not.toContain("$schema");
    }
  });

  it("logs a provider 4xx server-side (status and the ErrorInfo reason; key, message, other details and prompt never, even when the message quotes the request) while the thrown error stays the fixed safe message", async () => {
    const apiKey = "AIzaTEST-not-a-real-key-0123456789abcdef";
    // Quotes the request body back in its message, as Google's INVALID_ARGUMENT text can.
    const fakeFetch: typeof fetch = async (_url, init) =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: `Invalid value (key ${apiKey}) in request ${String(init?.body)}`,
            status: "INVALID_ARGUMENT",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" },
              { "@type": "type.googleapis.com/google.rpc.BadRequest", note: "DETAILS-ONLY" },
            ],
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = new GeminiLlmClient({ apiKey, fetch: fakeFetch });
      let caught: unknown;
      try {
        await client.complete({ systemPrompt: "s", userPrompt: "DOCUMENT-TEXT-MARKER", schema });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: safeMessageFor("UPSTREAM_UNAVAILABLE") });
      expect(isRetryableProviderError(caught)).toBe(false);
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      const logged = lines.filter((line) => line.includes("llm_provider_rejected")).map((line) => JSON.parse(line));
      expect(logged).toEqual([
        {
          event: "llm_provider_rejected",
          model: "gemini-2.5-flash",
          httpStatus: 400,
          providerStatus: "INVALID_ARGUMENT",
          providerReason: "API_KEY_INVALID",
        },
      ]);
      const all = lines.join("\n");
      expect(all).not.toContain(apiKey);
      expect(all).not.toContain("DETAILS-ONLY");
      expect(all).not.toContain("DOCUMENT-TEXT-MARKER");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not log a 5xx — a retryable outage, not a rejection of the request (negative control)", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = new GeminiLlmClient({ apiKey: "k", fetch: fakeFetch });
      await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(warn.mock.calls.map((args) => args.map(String).join(" ")).join("\n")).not.toContain("llm_provider_rejected");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the thinking budget reaches Gemini only when a caller sets one", () => {
  it("forwards thinkingBudget as config.thinkingConfig on complete() and stream(), and sends none when unset", async () => {
    const sent: GenerateContentParameters[] = [];
    const answer = { text: JSON.stringify({ answer: "ok" }), usageMetadata: {} };
    const transport: GeminiModelsTransport = {
      generateContent: async (params) => {
        sent.push(params);
        return answer;
      },
      generateContentStream: async (params) => {
        sent.push(params);
        return (async function* () {
          yield answer;
        })();
      },
    };
    const client = new GeminiLlmClient({ apiKey: "k", transport });

    await client.complete({ systemPrompt: "s", userPrompt: "u", schema, thinkingBudget: 0 });
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema, thinkingBudget: 0 })) void event;
    await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(sent).toHaveLength(3);
    expect(sent[0].config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(sent[1].config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(sent[2].config).not.toHaveProperty("thinkingConfig");
  });

  it("a client built with sendThinkingBudget: false never sends one, even when the caller sets 0 (complete and stream)", async () => {
    const sent: GenerateContentParameters[] = [];
    const answer = { text: JSON.stringify({ answer: "ok" }), usageMetadata: {} };
    const transport: GeminiModelsTransport = {
      generateContent: async (params) => {
        sent.push(params);
        return answer;
      },
      generateContentStream: async (params) => {
        sent.push(params);
        return (async function* () {
          yield answer;
        })();
      },
    };
    const client = new GeminiLlmClient({ apiKey: "k", transport, sendThinkingBudget: false });

    await client.complete({ systemPrompt: "s", userPrompt: "u", schema, thinkingBudget: 0 });
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema, thinkingBudget: 0 })) void event;

    expect(sent).toHaveLength(2);
    for (const params of sent) expect(params.config).not.toHaveProperty("thinkingConfig");
  });
});

describe("a Gemini-API model that cannot read files (Gemma)", () => {
  it("reports nativeDocumentInput: false and refuses a native file before any provider call (complete and stream)", async () => {
    const transport: GeminiModelsTransport = {
      generateContent: vi.fn(async () => ({ text: JSON.stringify({ answer: "ok" }), usageMetadata: {} })),
      generateContentStream: vi.fn(async () => (async function* () {})()),
    };
    const client = new GeminiLlmClient({ apiKey: "k", transport, nativeDocumentInput: false });
    const documents = [{ nativeFile: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } }];

    expect(client.capabilities.nativeDocumentInput).toBe(false);
    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema, documents })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      (async () => {
        for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema, documents })) void event;
      })(),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(transport.generateContent).not.toHaveBeenCalled();
    expect(transport.generateContentStream).not.toHaveBeenCalled();

    const answered = await client.complete({ systemPrompt: "s", userPrompt: "u", schema, documents: [{ canonicalText: "text" }] });
    expect(answered.data).toEqual({ answer: "ok" });
  });
});
