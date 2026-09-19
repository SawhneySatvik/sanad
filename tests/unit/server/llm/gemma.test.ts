import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { safeMessageFor } from "@/server/core/errors";
import { type ContractHarness, HARNESS_SECRET_API_KEY, runLlmContract } from "@tests/support/contracts/llm-client";
import { type GemmaChatClient, type GemmaCompletionResult, GemmaLlmClient } from "@/server/llm/gemma";

const schema = z.object({ answer: z.string() });

// A fake at the exact SDK boundary this adapter calls (openai's
// `chat.completions.create`, via gemma.ts's own `GemmaChatClient`
// abstraction) — see gemma.ts.
function makeFakeTransport() {
  const queue: Array<() => Promise<GemmaCompletionResult>> = [];
  const enqueue = (thunk: () => Promise<GemmaCompletionResult>) => queue.push(thunk);

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

  const transport: GemmaChatClient = {
    async createChat(_params, options) {
      const next = queue.shift();
      if (!next) throw new Error("test harness: no response queued");
      return Promise.race([next(), watchAbort(options?.signal)]);
    },
    async createChatStream(_params, options) {
      const next = queue.shift();
      if (!next) throw new Error("test harness: no response queued");
      const result = await Promise.race([next(), watchAbort(options?.signal)]);
      return (async function* () {
        yield { choices: result.choices.map((c) => ({ delta: { content: c.message?.content ?? "" }, index: 0, finish_reason: null })), usage: result.usage };
      })();
    },
  };

  return { transport, enqueue };
}

function makeGemmaHarness(): ContractHarness {
  const { transport, enqueue } = makeFakeTransport();
  const client = new GemmaLlmClient({ apiKey: HARNESS_SECRET_API_KEY, baseURL: "https://example.invalid/v1", transport });
  return {
    client,
    secretApiKey: HARNESS_SECRET_API_KEY,
    queueText: (rawText) =>
      enqueue(async () => ({
        choices: [{ message: { content: rawText, role: "assistant", refusal: null }, index: 0, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })),
    queueError: (status, retryAfterSeconds) =>
      enqueue(async () => {
        const headers = new Headers();
        if (retryAfterSeconds !== undefined) headers.set("retry-after", String(retryAfterSeconds));
        // Realistic shape: an APIError-like object carrying `.status` and
        // `.headers`, with the fake secret embedded in the message the way a
        // raw SDK/gateway error body plausibly could.
        throw { status, headers, message: `upstream error (key=${HARNESS_SECRET_API_KEY})` };
      }),
    queueHang: () => enqueue(() => new Promise<GemmaCompletionResult>(() => {})),
  };
}

runLlmContract("GemmaLlmClient (NVIDIA NIM / OpenRouter shape)", makeGemmaHarness);

describe("GemmaLlmClient — Gemma-specific behavior", () => {
  it("has capabilities.nativeDocumentInput: false and capabilities.streaming: true", () => {
    const { client } = makeGemmaHarness();
    expect(client.capabilities.nativeDocumentInput).toBe(false);
    expect(client.capabilities.streaming).toBe(true);
  });

  it("rejects a nativeFile document with VALIDATION_FAILED — this transport only accepts text", async () => {
    const { client } = makeGemmaHarness();
    await expect(
      client.complete({
        systemPrompt: "s",
        userPrompt: "u",
        schema,
        documents: [{ nativeFile: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("folds the JSON schema into the system message and canonicalText documents into the user message", async () => {
    const queue: unknown[] = [];
    const transport: GemmaChatClient = {
      createChat: async (params) => {
        queue.push(params);
        return {
          choices: [{ message: { content: JSON.stringify({ answer: "ok" }), role: "assistant", refusal: null }, index: 0, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
      createChatStream: async () => (async function* () {})(),
    };
    const client = new GemmaLlmClient({ apiKey: "k", baseURL: "https://example.invalid/v1", transport });
    await client.complete({
      systemPrompt: "you are a lawyer",
      userPrompt: "analyze this",
      schema,
      documents: [{ canonicalText: "lease clause 4.2" }],
    });

    expect(queue).toHaveLength(1);
    const sent = queue[0] as { messages: Array<{ role: string; content: string }>; response_format: { type: string } };
    expect(sent.response_format.type).toBe("json_object");
    const system = sent.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("you are a lawyer");
    expect(system?.content).toContain('"type":"object"');
    const user = sent.messages.find((m) => m.role === "user");
    expect(user?.content).toContain("analyze this");
    expect(user?.content).toContain("lease clause 4.2");
  });

  // Exercises the default transport builder itself, via the real `openai` SDK's own injectable-fetch
  // constructor option — never touches `globalThis.fetch`, so the no-network guard never sees it.
  // Keeping the retry-after value small matters: unpatched, the SDK sleeps on it before each retry.
  it("the default transport makes exactly 1 HTTP attempt on a 429 — no SDK-level retry", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
      });
    };
    const client = new GemmaLlmClient({ apiKey: "k", baseURL: "https://integrate.api.nvidia.com/v1", fetch: fakeFetch });

    let caught: unknown;
    try {
      await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    } catch (error) {
      caught = error;
    }

    expect(calls).toBe(1);
    expect(caught).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 1 });
  });

  // See the matching test in gemini.test.ts for the full rationale.
  it("bounds a call with no per-call timeoutMs using the client's defaultTimeoutMs", async () => {
    const transport: GemmaChatClient = {
      createChat: (_params, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        }),
      createChatStream: () => new Promise(() => {}),
    };
    const client = new GemmaLlmClient({
      apiKey: "k",
      baseURL: "https://example.invalid/v1",
      transport,
      defaultTimeoutMs: 20,
    });
    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});

describe("the schema Gemma is shown, and what a rejected call logs", () => {
  it("shows the model the provider-facing schema — no maxItems or $schema — while zod still rejects an over-cap answer", async () => {
    const capped = z.object({ items: z.array(z.string()).max(3) });
    expect(JSON.stringify(z.toJSONSchema(capped))).toContain('"maxItems":3');
    const systems: string[] = [];
    const overCap = JSON.stringify({ items: ["a", "b", "c", "d"] });
    const transport: GemmaChatClient = {
      createChat: async (params) => {
        systems.push(String(params.messages[0].content));
        return {
          choices: [{ message: { content: overCap, role: "assistant", refusal: null }, index: 0, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
      createChatStream: async (params) => {
        systems.push(String(params.messages[0].content));
        return (async function* () {
          yield { choices: [{ delta: { content: overCap }, index: 0, finish_reason: "stop" }], usage: null };
        })();
      },
    };
    const client = new GemmaLlmClient({ apiKey: "k", baseURL: "https://example.invalid/v1", transport });

    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema: capped })).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    const events: unknown[] = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema: capped })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "SCHEMA_FAILED" });

    expect(systems).toHaveLength(4);
    for (const system of systems) {
      expect(system).toContain('"items"');
      expect(system).not.toContain("maxItems");
      expect(system).not.toContain("$schema");
    }
  });

  it("logs a gateway 4xx server-side (status and the gateway's code; key and prompt never, even when the gateway's message quotes the request) while the thrown error stays the fixed safe message", async () => {
    const apiKey = "nvapi-TEST-not-a-real-key-0123456789";
    // Echoes the request body back in its message, as a gateway rejecting a request can.
    const fakeFetch: typeof fetch = async (_url, init) =>
      new Response(
        JSON.stringify({
          error: { message: `Model not found (key ${apiKey}) for request ${String(init?.body)}`, code: "model_not_found", type: "invalid_request_error" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = new GemmaLlmClient({ apiKey, baseURL: "https://integrate.api.nvidia.com/v1", fetch: fakeFetch });
      let caught: unknown;
      try {
        await client.complete({ systemPrompt: "s", userPrompt: "DOCUMENT-TEXT-MARKER", schema });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: safeMessageFor("UPSTREAM_UNAVAILABLE") });
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      const logged = lines.filter((line) => line.includes("llm_provider_rejected")).map((line) => JSON.parse(line));
      expect(logged).toEqual([
        {
          event: "llm_provider_rejected",
          model: "google/gemma-4-31b-it",
          httpStatus: 404,
          providerStatus: "model_not_found",
          providerReason: null,
        },
      ]);
      const all = lines.join("\n");
      expect(all).not.toContain(apiKey);
      expect(all).not.toContain("DOCUMENT-TEXT-MARKER");
    } finally {
      warn.mockRestore();
    }
  });
});
