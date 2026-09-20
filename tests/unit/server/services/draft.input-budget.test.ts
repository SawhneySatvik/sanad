import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_INPUT_BUDGET_CHARS } from "@/server/llm/timeouts";
import { create } from "@/server/services/draft";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, draftModelOutput, guestA, type Harness, readyDocument } from "@tests/support/services/draft";

// Only a grounding document can take Draft's prompt over its input budget: then the draft is
// refused before the model call, with a typed error — the document is never cut to fit.

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const SENTENCE = "The Disclosing Party shares product plans with the Receiving Party for evaluation only. ";

async function groundingDocument(chars: number) {
  return readyDocument(h.t, guestA, SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars).trim());
}

function grounded(documentId: string) {
  return { mode: "document_grounded" as const, documentType: "nda" as const, groundingDocumentId: documentId, userInstructions: "Draft a mutual NDA.", jurisdiction: "IN" };
}

describe("create — Draft's model input budget", () => {
  it("a grounding document over the budget: INVALID_DOCUMENT with zero model calls and no draft", async () => {
    const document = await groundingDocument(MODEL_INPUT_BUDGET_CHARS.draft + 1_000);
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });

    await expect(create(h.deps(llm), guestA, grounded(document.id))).rejects.toMatchObject({ code: "INVALID_DOCUMENT", reason: "grounding_too_long" });

    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toEqual({ drafts: 0, sections: 0 });
  });

  it("positive control: a grounding document under the budget drafts with one model call", async () => {
    const document = await groundingDocument(MODEL_INPUT_BUDGET_CHARS.draft - 10_000);
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });

    const draft = await create(h.deps(llm), guestA, grounded(document.id));

    expect(draft.groundingDocumentAvailable).toBe(true);
    expect(llm.callCount).toBe(1);
    expect(llm.calls[0].userPrompt.length).toBeLessThanOrEqual(MODEL_INPUT_BUDGET_CHARS.draft);
  });
});
