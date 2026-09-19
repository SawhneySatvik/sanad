import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeProviderError } from "@/server/llm/errors";
import { type ContractHarness, HARNESS_SECRET_API_KEY, runLlmContract } from "@tests/support/contracts/llm-client";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";

const schema = z.object({ answer: z.string() });

function makeFakeHarness(): ContractHarness {
  const client = new FakeLlmClient({ modelUsed: "fake-model" });
  return {
    client,
    secretApiKey: HARNESS_SECRET_API_KEY, // FakeLlmClient never takes a key at all — trivially never leaks it
    // A fixed {input:1, output:1} per attempt, matching gemini.test.ts and
    // gemma.test.ts's harnesses — lets the shared contract suite assert an
    // EXACT tokensUsed total (see contract.ts), not just ">= 0".
    queueText: (rawText) => client.enqueue({ rawText, tokensUsed: { input: 1, output: 1 } }),
    // Routed through the SAME `normalizeProviderError` every real adapter calls, so a hard-coded
    // `retryable: true` slipped into one adapter's own error path wouldn't be masked by this
    // harness scripting retryability by hand instead of deriving it the same way.
    queueError: (status, retryAfterSeconds) => {
      const headers = retryAfterSeconds !== undefined ? new Headers({ "retry-after": String(retryAfterSeconds) }) : undefined;
      client.enqueue({ error: normalizeProviderError({ status, headers }) });
    },
    queueHang: () => client.enqueue({ hang: true }),
  };
}

runLlmContract("FakeLlmClient", makeFakeHarness);

describe("FakeLlmClient — fake-specific behavior", () => {
  it("counts top-level complete() calls, not provider attempts (repair retry is 1 call, 2 attempts)", async () => {
    const client = new FakeLlmClient({
      responses: [{ rawText: "not json" }, { data: { answer: "fixed" } }],
    });
    await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    expect(client.callCount).toBe(1);
  });

  it("records every call's input in order", async () => {
    const client = new FakeLlmClient({ responses: [{ data: { answer: "a" } }, { data: { answer: "b" } }] });
    await client.complete({ systemPrompt: "sys1", userPrompt: "user1", schema });
    await client.complete({ systemPrompt: "sys2", userPrompt: "user2", schema });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].systemPrompt).toBe("sys1");
    expect(client.calls[1].systemPrompt).toBe("sys2");
  });

  it("supports a function script for dynamic per-attempt responses", async () => {
    const client = new FakeLlmClient({
      responses: [({ input }) => ({ data: { answer: input.userPrompt } })],
    });
    const result = await client.complete({ systemPrompt: "s", userPrompt: "echoed", schema });
    expect(result.data).toEqual({ answer: "echoed" });
  });

  it("throws a helpful error when the queue is exhausted and no defaultResponse is set", async () => {
    const client = new FakeLlmClient({ responses: [] });
    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toThrow(
      /no scripted response/,
    );
  });

  it("defaultResponse answers indefinitely once the queue is exhausted", async () => {
    const client = new FakeLlmClient({ responses: [], defaultResponse: { data: { answer: "always" } } });
    const first = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    const second = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    expect(first.data).toEqual({ answer: "always" });
    expect(second.data).toEqual({ answer: "always" });
    expect(client.callCount).toBe(2);
  });

  it("defaults capabilities.nativeDocumentInput to false and rejects a nativeFile document", async () => {
    const client = new FakeLlmClient({ responses: [{ data: { answer: "x" } }] });
    expect(client.capabilities.nativeDocumentInput).toBe(false);
    await expect(
      client.complete({
        systemPrompt: "s",
        userPrompt: "u",
        schema,
        documents: [{ nativeFile: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts nativeFile documents when configured with nativeDocumentInput: true", async () => {
    const client = new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      responses: [{ data: { answer: "x" } }],
    });
    const result = await client.complete({
      systemPrompt: "s",
      userPrompt: "u",
      schema,
      documents: [{ nativeFile: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } }],
    });
    expect(result.data).toEqual({ answer: "x" });
  });

  it("honors a configurable modelUsed, per-response or client-default", async () => {
    const client = new FakeLlmClient({
      modelUsed: "default-model",
      responses: [{ data: { answer: "a" } }, { data: { answer: "b" }, modelUsed: "override-model" }],
    });
    const first = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    const second = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    expect(first.modelUsed).toBe("default-model");
    expect(second.modelUsed).toBe("override-model");
  });
});
