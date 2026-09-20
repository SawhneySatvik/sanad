// Cross-principal access to the Draft service: a document or draft that exists but belongs to
// someone else is NOT_FOUND, indistinguishable from one that does not exist — and never spends an
// LLM call getting there.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@/server/core/types";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { create, get, revise } from "@/server/services/draft";
import { caught, createHarness, draftModelOutput, guestA, guestB, readyDocument, type Harness, userA, userB } from "@tests/support/services/draft";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";

async function fromScratchDraftOf(owner: Principal): Promise<string> {
  const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] });
  const result = await create(h.deps(llm), owner, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" });
  return result.id;
}

describe.each([
  ["user B against user A's document/draft", userA, userB],
  ["guest B against guest A's document/draft", guestA, guestB],
  ["a user against a guest's document/draft", guestA, userA],
  ["a guest against a user's document/draft", userA, guestA],
])("IDOR — %s", (_label, owner, intruder) => {
  it("create() in document_grounded mode: foreign, missing and malformed groundingDocumentId are the same NOT_FOUND, never call the model, create nothing", async () => {
    const doc = await readyDocument(h.t, owner);
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("grounded_response") } });
    const attempt = (groundingDocumentId: string) =>
      caught(create(h.deps(llm), intruder, { mode: "document_grounded", documentType: "grounded_response", groundingDocumentId, userInstructions: "x", jurisdiction: "IN" }));

    const foreign = await attempt(doc.id);
    const missing = await attempt(MISSING_ID);
    const malformed = await attempt("1 OR 1=1");
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);
    expect(llm.callCount).toBe(0);
    expect((await h.counts()).drafts).toBe(0);

    // Positive control: the owner can.
    const own = await create(h.deps(llm), owner, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "x",
      jurisdiction: "IN",
    });
    expect(own.groundingDocumentId).toBe(doc.id);
  });

  it("revise(): foreign, missing and malformed parentDraftId are the same NOT_FOUND, never call the model, create no revision", async () => {
    const draftId = await fromScratchDraftOf(owner);
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });
    const attempt = (parentDraftId: string) => caught(revise(h.deps(llm), intruder, parentDraftId, { userInstructions: "revise it" }));

    const foreign = await attempt(draftId);
    const missing = await attempt(MISSING_ID);
    const malformed = await attempt("1 OR 1=1");
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);
    expect(llm.callCount).toBe(0);
    expect((await h.counts()).drafts).toBe(1); // only the root — no revision was created

    const own = await revise(h.deps(llm), owner, draftId, { userInstructions: "revise it" });
    expect(own.parentDraftId).toBe(draftId);
  });

  it("get() is NOT_FOUND, identical to a missing and a malformed id; the owner still reads it", async () => {
    const draftId = await fromScratchDraftOf(owner);
    const llm = new FakeLlmClient();

    const foreign = await caught(get(h.deps(llm), intruder, draftId));
    const missing = await caught(get(h.deps(llm), intruder, MISSING_ID));
    const malformed = await caught(get(h.deps(llm), intruder, "1 OR 1=1"));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);

    const own = await get(h.deps(llm), owner, draftId);
    expect(own.id).toBe(draftId);
  });
});
