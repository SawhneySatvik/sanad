// Cross-principal access to the Understand service: a document that
// exists but belongs to someone else is NOT_FOUND, indistinguishable from one that does not exist.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { analyze, analyzeDocument, DocumentAnalysisError, get } from "@/server/services/understand";
import {
  createHarness,
  findingsOf,
  guestA,
  guestB,
  type Harness,
  leaseOutput,
  MIME,
  userA,
  userB,
} from "@tests/support/services/understand";

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

async function analysedDocumentOf(owner: Principal): Promise<string> {
  const llm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
  const result = await analyze(h.deps(llm), owner, await h.upload(owner, "leave_and_license.txt", MIME.txt));
  return result.document.id;
}

// Extracted, but its analysis call failed: the state a retry targets. Nothing downstream of
// analyzeDocument's own reads (no existing analysis, no cache entry) would reject an intruder here.
async function readyUnanalysedDocumentOf(owner: Principal): Promise<string> {
  const failing = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "down") }] });
  const input = await h.upload(owner, "leave_and_license.txt", MIME.txt);
  await expect(analyze(h.deps(failing), owner, input)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  const [row] = await h.t.db.select().from(schema.documents);
  expect([row.processingStatus, (await h.counts()).analyses, (await h.counts()).cache]).toEqual(["ready", 0, 0]);
  return row.id;
}

// A scan whose transcription call failed transiently: still pending.
async function pendingDocumentOf(owner: Principal): Promise<string> {
  const failing = new FakeLlmClient({
    capabilities: { nativeDocumentInput: true },
    responses: [{ error: new AppError("RATE_LIMITED", "slow down") }],
  });
  const input = await h.upload(owner, "scanned_no_text_layer.pdf", MIME.pdf);
  await expect(analyze(h.deps(failing), owner, input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  const [row] = await h.t.db.select().from(schema.documents);
  expect(row.processingStatus).toBe("pending");
  return row.id;
}

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";

describe.each([
  ["user B reading user A's document", userA, userB],
  ["guest B reading guest A's document", guestA, guestB],
  ["a user reading a guest's document", guestA, userA],
  ["a guest reading a user's document", userA, guestA],
])("IDOR — %s", (_label, owner, intruder) => {
  it("get() is NOT_FOUND, identical to a missing and a malformed id; the owner still reads it", async () => {
    const documentId = await analysedDocumentOf(owner);
    const deps = h.deps(new FakeLlmClient());

    const foreign = await caught(get(deps, intruder, documentId));
    const missing = await caught(get(deps, intruder, MISSING_ID));
    const malformed = await caught(get(deps, intruder, "not-a-uuid"));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);

    const own = await get(deps, owner, documentId);
    expect(own.document.id).toBe(documentId);
    expect(findingsOf(own).length).toBeGreaterThan(0);
  });

  it("analyzeDocument() on a foreign READY, not-yet-analysed document is NOT_FOUND, never reaches the model, writes nothing", async () => {
    const documentId = await readyUnanalysedDocumentOf(owner);
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });

    const foreign = await caught(analyzeDocument(h.deps(llm), intruder, documentId));
    const missing = await caught(analyzeDocument(h.deps(llm), intruder, MISSING_ID));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toMatchObject({ analyses: 0, findings: 0, cache: 0 });

    // Positive control: the owner's retry of the same document goes through.
    const own = await analyzeDocument(h.deps(llm), owner, documentId);
    expect(own.analysisState).toBe("complete");
    expect(llm.callCount).toBe(1);
  });

  it("analyzeDocument() on a foreign PENDING document is NOT_FOUND and never extracts or transcribes it", async () => {
    const documentId = await pendingDocumentOf(owner);
    const llm = new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, defaultResponse: { data: { text: "x" } } });

    expect((await caught(analyzeDocument(h.deps(llm), intruder, documentId))).code).toBe("NOT_FOUND");
    expect(llm.callCount).toBe(0);
    const [row] = await h.t.db.select().from(schema.documents);
    expect([row.processingStatus, row.canonicalText]).toEqual(["pending", null]);
  });

  it("analyze() with the owner's storage ref is NOT_FOUND, creates nothing, and leaves the upload usable by its owner", async () => {
    const input = await h.upload(owner, "leave_and_license.txt", MIME.txt);
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });

    const error = await caught(analyze(h.deps(llm), intruder, input));
    expect(error.code).toBe("NOT_FOUND");
    // Rejected before any row exists: no document id rides on the error.
    expect(error).not.toBeInstanceOf(DocumentAnalysisError);
    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toMatchObject({ documents: 0, analyses: 0 });

    const own = await analyze(h.deps(llm), owner, input);
    expect(own.document.storageRef).toBe(input.storageRef);
  });
});
