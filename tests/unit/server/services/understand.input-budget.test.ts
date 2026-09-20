import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocument } from "@/server/data/documents";
import { MODEL_INPUT_BUDGET_CHARS } from "@/server/llm/timeouts";
import { buildUnderstandUserPrompt } from "@/server/prompts/understand/analyze";
import { analyze, analyzeDocument, DocumentAnalysisError } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, guestA, type Harness, MIME } from "@tests/support/services/understand";

// A document whose prompt exceeds Understand's input budget is refused before any model call, with
// a typed error — never cut to fit — and stays ready: its text is fine, only too long to analyze.

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const SENTENCE = "The Licensee shall pay the monthly license fee on or before the fifth day of each month. ";

function textOf(chars: number): Uint8Array {
  return new TextEncoder().encode(SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars).trim());
}

describe("analyze — Understand's model input budget", () => {
  it("over the budget: INVALID_DOCUMENT with the documentId, zero model calls, no analysis, and the document stays ready", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: { findings: [] } } });
    const input = await h.uploadBytes(guestA, "long.txt", MIME.txt, textOf(MODEL_INPUT_BUDGET_CHARS.understand + 1_000));

    const error = await analyze(h.deps(llm), guestA, input).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(DocumentAnalysisError);
    const { code, reason, documentId } = error as DocumentAnalysisError;
    expect(code).toBe("INVALID_DOCUMENT");
    expect(reason).toBe("too_large");
    expect(llm.callCount).toBe(0);
    expect((await h.counts()).analyses).toBe(0);
    const document = await getDocument(h.t.db, guestA, documentId);
    expect(document.processingStatus).toBe("ready");
    expect(document.canonicalText!.length).toBeGreaterThan(MODEL_INPUT_BUDGET_CHARS.understand);
    // The message reports the length actually compared: the whole prompt, not just the text.
    const promptLength = buildUnderstandUserPrompt({ canonicalText: document.canonicalText!, canonicalTextHash: document.canonicalTextHash! }).length;
    expect((error as DocumentAnalysisError).message).toContain(`${promptLength} characters`);

    // A retry is refused the same way, and still costs no model call.
    await expect(analyzeDocument(h.deps(llm), guestA, documentId)).rejects.toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });
    expect(llm.callCount).toBe(0);
  });

  it("positive control: a document under the budget is analyzed with one model call", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: { findings: [] } } });
    const input = await h.uploadBytes(guestA, "long.txt", MIME.txt, textOf(MODEL_INPUT_BUDGET_CHARS.understand - 1_000));

    const result = await analyze(h.deps(llm), guestA, input);

    expect(result.analysisState).toBe("complete");
    expect(llm.callCount).toBe(1);
    expect(llm.calls[0].userPrompt.length).toBeLessThanOrEqual(MODEL_INPUT_BUDGET_CHARS.understand);
  });
});
