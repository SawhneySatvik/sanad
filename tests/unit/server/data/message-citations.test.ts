import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERIFIER_VERSION, verifyMany } from "@/server/deterministic/verify";
import { createAskHarness, LEASE, QUOTES, userA, type AskHarness } from "@tests/support/services/ask";
import type { Document } from "@/server/data/documents";
import {
  countCitations,
  insertCitations,
  listVerifiedCitations,
  MAX_VERIFIED_CITATIONS_PER_READ,
  verifyCitationQuotes,
} from "@/server/data/message-citations";
import { appendMessage } from "@/server/data/messages";
import type { Thread } from "@/server/data/threads";

let h: AskHarness;
let doc: Document;
let thread: Thread;

beforeEach(async () => {
  h = await createAskHarness();
  doc = await h.document(userA);
  thread = await h.thread(userA, [doc]);
});
afterEach(() => h.close());

function groundedMessage(threadId = thread.id) {
  return appendMessage(h.t.db, userA, threadId, { role: "assistant", content: "answer", mode: "grounded", modelUsed: "fake-model" });
}

function results(quotes: string[], document: Document = doc) {
  return verifyMany(quotes, document.canonicalText!, document.inputMode!);
}

describe("insertCitations", () => {
  it("writes status, spans and verifier_version from each VerifyResult, in input order", async () => {
    const message = await groundedMessage();
    const quotes = [QUOTES.deposit, QUOTES.fabricated, QUOTES.lockIn];
    const verified = results(quotes);
    const rows = await insertCitations(
      h.t.db,
      userA,
      message.id,
      quotes.map((quote, i) => ({ quote, source: { documentId: doc.id, verification: verified[i] } })),
    );

    expect(rows.map((row) => [row.quoteText, row.verificationStatus])).toEqual([
      [QUOTES.deposit, "verified"],
      [QUOTES.fabricated, "not_found"],
      [QUOTES.lockIn, "verified"],
    ]);
    expect(doc.canonicalText!.slice(rows[0].quoteSpanStart!, rows[0].quoteSpanEnd!)).toBe(QUOTES.deposit);
    expect(rows[1].quoteSpanStart).toBeNull();
    expect(rows.every((row) => row.verifierVersion === VERIFIER_VERSION && row.sourceDocumentId === doc.id)).toBe(true);
  });

  it("stores a citation with no source document unlinked and not_found, whatever the quote", async () => {
    const message = await groundedMessage();
    const [row] = await insertCitations(h.t.db, userA, message.id, [{ quote: QUOTES.deposit, source: null }]);
    expect(row).toMatchObject({
      quoteText: QUOTES.deposit,
      sourceDocumentId: null,
      verificationStatus: "not_found",
      quoteSpanStart: null,
      quoteSpanEnd: null,
      verifierVersion: VERIFIER_VERSION,
    });
  });

  it("refuses citations on a user message or a general-mode message, writing nothing", async () => {
    const user = await appendMessage(h.t.db, userA, thread.id, { role: "user", content: "q" });
    const general = await appendMessage(h.t.db, userA, thread.id, {
      role: "assistant",
      content: "a",
      mode: "general",
      modelUsed: "fake-model",
    });
    const [verification] = results([QUOTES.deposit]);
    for (const message of [user, general]) {
      await expect(
        insertCitations(h.t.db, userA, message.id, [{ quote: QUOTES.deposit, source: { documentId: doc.id, verification } }]),
      ).rejects.toThrow("Citations can only be written for a grounded assistant message");
    }
    expect((await h.counts()).citations).toBe(0);
  });

  it("returns [] for no citations", async () => {
    const message = await groundedMessage();
    expect(await insertCitations(h.t.db, userA, message.id, [])).toEqual([]);
  });
});

describe("listVerifiedCitations", () => {
  it("returns every citation of the named messages, in write order, each with a fresh VerifyResult", async () => {
    const first = await groundedMessage();
    const second = await groundedMessage();
    const [deposit, fabricated] = results([QUOTES.deposit, QUOTES.fabricated]);
    await insertCitations(h.t.db, userA, first.id, [
      { quote: QUOTES.deposit, source: { documentId: doc.id, verification: deposit } },
      { quote: QUOTES.fabricated, source: { documentId: doc.id, verification: fabricated } },
    ]);
    await insertCitations(h.t.db, userA, second.id, [{ quote: QUOTES.lockIn, source: null }]);

    const citations = (await listVerifiedCitations(h.t.db, userA, thread.id, [first.id, second.id, "not-a-uuid"])).citations;
    expect(citations.map((c) => [c.messageId, c.quote, c.sourceDocumentId, c.verification.status])).toEqual([
      [first.id, QUOTES.deposit, doc.id, "verified"],
      [first.id, QUOTES.fabricated, doc.id, "not_found"],
      // Unlinked stays unlinked, and not_found, even though the quote IS in the thread's document.
      [second.id, QUOTES.lockIn, null, "not_found"],
    ]);
    const verified = citations[0].verification;
    expect(LEASE.includes(QUOTES.deposit)).toBe(true);
    expect(doc.canonicalText!.slice(verified.spanStart!, verified.spanEnd!)).toBe(QUOTES.deposit);
  });

  it("returns only the citations of messages it was asked for", async () => {
    const asked = await groundedMessage();
    const other = await groundedMessage();
    await insertCitations(h.t.db, userA, other.id, [{ quote: QUOTES.deposit, source: null }]);
    expect((await listVerifiedCitations(h.t.db, userA, thread.id, [asked.id])).citations).toEqual([]);
    expect((await listVerifiedCitations(h.t.db, userA, thread.id, [])).citations).toEqual([]);
    expect((await listVerifiedCitations(h.t.db, userA, thread.id, [other.id])).citations).toHaveLength(1);
  });
});

describe("the per-read re-verification budget", () => {
  it("countCitations counts each message's citations in the thread", async () => {
    const first = await groundedMessage();
    const second = await groundedMessage();
    const none = await groundedMessage();
    await insertCitations(h.t.db, userA, first.id, [{ quote: QUOTES.deposit, source: null }]);
    await insertCitations(h.t.db, userA, second.id, [
      { quote: QUOTES.deposit, source: null },
      { quote: QUOTES.lockIn, source: null },
    ]);
    const counts = await countCitations(h.t.db, userA, thread.id, [first.id, second.id, none.id, "not-a-uuid"]);
    expect(Object.fromEntries(counts)).toEqual({ [first.id]: 1, [second.id]: 2 });
    expect(await countCitations(h.t.db, userA, thread.id, [])).toEqual(new Map());
  });

  it("listVerifiedCitations refuses more than MAX_VERIFIED_CITATIONS_PER_READ before verifying any; exactly the budget is fine", async () => {
    const message = await groundedMessage();
    const writes = Array.from({ length: MAX_VERIFIED_CITATIONS_PER_READ }, () => ({ quote: QUOTES.deposit, source: null }));
    await insertCitations(h.t.db, userA, message.id, writes);
    expect((await listVerifiedCitations(h.t.db, userA, thread.id, [message.id])).citations).toHaveLength(MAX_VERIFIED_CITATIONS_PER_READ);

    await insertCitations(h.t.db, userA, message.id, [{ quote: QUOTES.deposit, source: null }]);
    await expect(listVerifiedCitations(h.t.db, userA, thread.id, [message.id])).rejects.toThrow(
      `listVerifiedCitations re-verifies at most ${MAX_VERIFIED_CITATIONS_PER_READ} citations per call`,
    );
  });
});

describe("verifyCitationQuotes", () => {
  it("verifies each quote against the document it names, chunked above 50 quotes per document", () => {
    const quotes = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? QUOTES.deposit : QUOTES.fabricated));
    const texts = new Map([[doc.id, { canonicalText: doc.canonicalText!, inputMode: doc.inputMode! }]]);
    const out = verifyCitationQuotes(
      [...quotes.map((quote) => ({ quote, documentId: doc.id })), { quote: QUOTES.deposit, documentId: "unknown-id" }, { quote: QUOTES.deposit, documentId: null }],
      texts,
    );
    expect(out).toHaveLength(122);
    expect(out.slice(0, 120).map((r) => r.status)).toEqual(quotes.map((q) => (q === QUOTES.deposit ? "verified" : "not_found")));
    expect(out.slice(0, 120).every((r, i) => r.quote === quotes[i] && r.canonicalTextHash === doc.canonicalTextHash)).toBe(true);
    expect(out.slice(120).map((r) => [r.status, r.spanStart])).toEqual([
      ["not_found", null],
      ["not_found", null],
    ]);
  });
});
