// Cross-principal access to the Prepare service: a document that exists but belongs to someone else
// is NOT_FOUND for both an analyzed and an unanalyzed document (returning `not_analyzed` to an
// intruder would confirm the document exists). Inherited from Understand's get() canAccess chokepoint.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { readyDocument } from "@tests/support/data/documents";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { generate } from "@/server/services/prepare";
import { analyze } from "@/server/services/understand";
import { LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";
import { aliasFor, complete, createHarness, guestA, guestB, type Harness, LEASE, leaseOutput, MIME, userA, userB } from "@tests/support/services/prepare";

// leave_and_license's own lens (valid for the owner's document) and job_offer_letter's (a real lens
// id, but never a lens of leave_and_license) — for the wrong-type-lens IDOR case below.
const OWN_TYPE_LENS = LENSES_BY_DOCUMENT_TYPE.leave_and_license[0].id;
const WRONG_TYPE_LENS = LENSES_BY_DOCUMENT_TYPE.job_offer_letter[0].id;

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function caught(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

async function analyzedDocumentOf(owner: Principal) {
  const llm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
  return analyze(h.deps(llm), owner, await h.upload(owner, "leave_and_license.txt", MIME.txt));
}

async function unanalyzedDocumentOf(owner: Principal): Promise<string> {
  const document = await readyDocument(h.t, owner);
  return document.id;
}

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";

describe.each([
  ["user B reading user A's document", userA, userB],
  ["guest B reading guest A's document", guestA, guestB],
  ["a user reading a guest's document", guestA, userA],
  ["a guest reading a user's document", userA, guestA],
])("IDOR — %s", (_label, owner, intruder) => {
  it("generate() on a foreign ANALYZED document is NOT_FOUND, identical to a missing/malformed id, never calls the LLM; the owner still succeeds", async () => {
    const analyzed = await analyzedDocumentOf(owner);
    const documentId = analyzed.document.id;
    const llm = new FakeLlmClient();
    const deps = h.deps(llm);

    const foreign = await caught(generate(deps, intruder, documentId));
    const missing = await caught(generate(deps, intruder, MISSING_ID));
    const malformed = await caught(generate(deps, intruder, "not-a-uuid"));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);
    expect(llm.callCount).toBe(0);

    // Positive control: the owner's own read goes through and produces prepared output.
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const ownerLlm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [] } }],
    });
    const own = complete(await generate(h.deps(ownerLlm), owner, documentId));
    expect(own.state).toBe("complete");
    expect(own.lawyerQuestions).toHaveLength(1);
  });

  it("generate() on a foreign document with a lens id of a DIFFERENT document type is NOT_FOUND, byte-identical to no lens at all — the lens check never runs before ownership, so it can't reveal the foreign document's own type", async () => {
    const analyzed = await analyzedDocumentOf(owner);
    const documentId = analyzed.document.id;
    const llm = new FakeLlmClient();

    const noLens = await caught(generate(h.deps(llm), intruder, documentId));
    const wrongTypeLens = await caught(generate(h.deps(llm), intruder, documentId, WRONG_TYPE_LENS));
    expect(wrongTypeLens.code).toBe("NOT_FOUND");
    expect([wrongTypeLens.code, wrongTypeLens.message]).toEqual([noLens.code, noLens.message]);
    expect(llm.callCount).toBe(0);

    // Positive control: the same lens id the intruder used above is a real, checked value — the
    // owner's own call with it succeeds instead of 404ing for everyone.
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const ownerLlm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [] } }],
    });
    const own = complete(await generate(h.deps(ownerLlm), owner, documentId, OWN_TYPE_LENS));
    expect(own.state).toBe("complete");
  });

  it("generate() on a foreign UNANALYZED document is NOT_FOUND — never leaks as a typed not_analyzed result — and never calls the LLM; the owner still succeeds", async () => {
    const documentId = await unanalyzedDocumentOf(owner);
    const llm = new FakeLlmClient();

    const foreign = await caught(generate(h.deps(llm), intruder, documentId));
    const missing = await caught(generate(h.deps(llm), intruder, MISSING_ID));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect(llm.callCount).toBe(0);

    // Positive control: the owner reads the same document and correctly sees not_analyzed (not a
    // 404) — proving the intruder's 404 above is really an access-control result, not a bug that
    // would 404 for everyone.
    const own = await generate(h.deps(llm), owner, documentId);
    expect(own.state).toBe("not_analyzed");
    expect(llm.callCount).toBe(0);
  });
});
