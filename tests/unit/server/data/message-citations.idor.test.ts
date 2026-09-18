// Cross-principal access to message_citations: a foreign message, thread or document is the same
// NOT_FOUND as a missing or malformed one, writes nothing, and a read never verifies against — or
// links — a document the reader cannot access. Each case has a positive control.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyMany } from "@/server/deterministic/verify";
import { caught, createAskHarness, QUOTES, userA, userB, type AskHarness } from "@tests/support/services/ask";
import type { Document } from "@/server/data/documents";
import { countCitations, insertCitations, listVerifiedCitations } from "@/server/data/message-citations";
import { appendMessage } from "@/server/data/messages";
import type { Thread } from "@/server/data/threads";

const MISSING_ID = "0190a000-0000-7000-8000-000000000000";

let h: AskHarness;
let docA: Document;
let docB: Document;
let threadA: Thread;
let threadB: Thread;

beforeEach(async () => {
  h = await createAskHarness();
  docA = await h.document(userA);
  docB = await h.document(userB);
  threadA = await h.thread(userA, [docA]);
  threadB = await h.thread(userB, [docB]);
});
afterEach(() => h.close());

function groundedMessage(principal = userA, threadId = threadA.id) {
  return appendMessage(h.t.db, principal, threadId, { role: "assistant", content: "answer", mode: "grounded", modelUsed: "fake-model" });
}

function resultFor(document: Document) {
  return verifyMany([QUOTES.deposit], document.canonicalText!, document.inputMode!)[0];
}

async function shape(promise: Promise<unknown>) {
  const error = await caught(promise);
  return { code: error.code, message: error.message };
}

describe("insertCitations", () => {
  it("into another user's message is NOT_FOUND, identical to a missing or malformed message id", async () => {
    const messageB = await groundedMessage(userB, threadB.id);
    const write = [{ quote: QUOTES.deposit, source: null }];

    const foreign = await shape(insertCitations(h.t.db, userA, messageB.id, write));
    expect(foreign.code).toBe("NOT_FOUND");
    expect(await shape(insertCitations(h.t.db, userA, MISSING_ID, write))).toEqual(foreign);
    expect(await shape(insertCitations(h.t.db, userA, "not-a-uuid", write))).toEqual(foreign);
    expect((await h.counts()).citations).toBe(0);

    // Positive control: the owner can.
    await insertCitations(h.t.db, userB, messageB.id, write);
    expect((await h.counts()).citations).toBe(1);
  });

  it("linking another user's document is NOT_FOUND, identical to a missing document, even with a result verify() issued for it", async () => {
    const messageA = await groundedMessage();
    const foreign = await shape(
      insertCitations(h.t.db, userA, messageA.id, [{ quote: QUOTES.deposit, source: { documentId: docB.id, verification: resultFor(docB) } }]),
    );
    expect(foreign.code).toBe("NOT_FOUND");
    const missing = await shape(
      insertCitations(h.t.db, userA, messageA.id, [{ quote: QUOTES.deposit, source: { documentId: MISSING_ID, verification: resultFor(docB) } }]),
    );
    expect(missing).toEqual(foreign);
    expect((await h.counts()).citations).toBe(0);

    // Positive control: linking the principal's own document.
    await insertCitations(h.t.db, userA, messageA.id, [{ quote: QUOTES.deposit, source: { documentId: docA.id, verification: resultFor(docA) } }]);
    expect((await h.counts()).citations).toBe(1);
  });
});

describe("listVerifiedCitations", () => {
  it("on another user's thread is NOT_FOUND, identical to a missing or malformed thread id", async () => {
    const messageB = await groundedMessage(userB, threadB.id);
    await insertCitations(h.t.db, userB, messageB.id, [{ quote: QUOTES.deposit, source: { documentId: docB.id, verification: resultFor(docB) } }]);

    const foreign = await shape(listVerifiedCitations(h.t.db, userA, threadB.id, [messageB.id]));
    expect(foreign.code).toBe("NOT_FOUND");
    expect(await shape(listVerifiedCitations(h.t.db, userA, MISSING_ID, [messageB.id]))).toEqual(foreign);
    expect(await shape(listVerifiedCitations(h.t.db, userA, "not-a-uuid", [messageB.id]))).toEqual(foreign);

    // Positive control.
    expect((await listVerifiedCitations(h.t.db, userB, threadB.id, [messageB.id])).citations).toHaveLength(1);
  });

  it("countCitations on another user's thread is NOT_FOUND, identical to a missing or malformed thread id; own thread never counts another's messages", async () => {
    const messageB = await groundedMessage(userB, threadB.id);
    await insertCitations(h.t.db, userB, messageB.id, [{ quote: QUOTES.deposit, source: null }]);

    const foreign = await shape(countCitations(h.t.db, userA, threadB.id, [messageB.id]));
    expect(foreign.code).toBe("NOT_FOUND");
    expect(await shape(countCitations(h.t.db, userA, MISSING_ID, [messageB.id]))).toEqual(foreign);
    expect(await shape(countCitations(h.t.db, userA, "not-a-uuid", [messageB.id]))).toEqual(foreign);
    expect(await countCitations(h.t.db, userA, threadA.id, [messageB.id])).toEqual(new Map());

    // Positive control.
    expect(Object.fromEntries(await countCitations(h.t.db, userB, threadB.id, [messageB.id]))).toEqual({ [messageB.id]: 1 });
  });

  it("never returns another thread's citations through the caller's own thread", async () => {
    const messageB = await groundedMessage(userB, threadB.id);
    await insertCitations(h.t.db, userB, messageB.id, [{ quote: QUOTES.deposit, source: { documentId: docB.id, verification: resultFor(docB) } }]);
    const messageA = await groundedMessage();
    await insertCitations(h.t.db, userA, messageA.id, [{ quote: QUOTES.deposit, source: { documentId: docA.id, verification: resultFor(docA) } }]);

    const citations = (await listVerifiedCitations(h.t.db, userA, threadA.id, [messageB.id, messageA.id])).citations;
    expect(citations.map((c) => c.messageId)).toEqual([messageA.id]);
  });

  it("a citation linking a document the reader cannot access reads not_found and unlinked — identical to a deleted document", async () => {
    // Only reachable by a direct write (insertCitations refuses the link); the read must not trust it.
    const messageA = await groundedMessage();
    await h.t.client.query(
      `INSERT INTO message_citations (message_id, quote_text, source_document_id, verification_status, verifier_version, quote_span_start, quote_span_end)
       VALUES ($1, $2, $3, 'verified', 'x', 0, 10), ($1, $2, NULL, 'not_found', 'x', NULL, NULL), ($1, $2, $4, 'not_found', 'x', NULL, NULL)`,
      [messageA.id, QUOTES.deposit, docB.id, docA.id],
    );
    // docB contains the quote: a read that verified against it would say verified.
    expect(resultFor(docB).status).toBe("verified");

    const [foreign, deleted, own] = ((await listVerifiedCitations(h.t.db, userA, threadA.id, [messageA.id])).citations).sort(
      (x, y) => Number(x.sourceDocumentId === docA.id) - Number(y.sourceDocumentId === docA.id),
    );
    for (const citation of [foreign, deleted]) {
      expect(citation.sourceDocumentId).toBeNull();
      expect([citation.verification.status, citation.verification.spanStart]).toEqual(["not_found", null]);
    }
    // Positive control: the reader's own document, stored as not_found, reads verified.
    expect(own.sourceDocumentId).toBe(docA.id);
    expect(own.verification.status).toBe("verified");
  });
});
