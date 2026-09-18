// One Guarantee at the message_citations repository: the orchestrator's plain statuses are never
// written; a VerifyResult binds to its quote, document text and input mode; the stored status is
// audit-only, so every read re-verifies; and a native_document citation never reads or writes verified.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verify, verifyMany, type VerifyResult } from "@/server/deterministic/verify";
import type { OrchestratorCitation } from "@/server/orchestrator";
import { createAskHarness, LEASE, QUOTES, userA, type AskHarness } from "@tests/support/services/ask";
import type { Document } from "@/server/data/documents";
import { insertCitations, listVerifiedCitations } from "@/server/data/message-citations";
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

function groundedMessage() {
  return appendMessage(h.t.db, userA, thread.id, { role: "assistant", content: "answer", mode: "grounded", modelUsed: "fake-model" });
}

async function storedRows() {
  const result = await h.t.client.query<{
    quote_text: string;
    verification_status: string;
    quote_span_start: number | null;
    source_document_id: string | null;
  }>("SELECT quote_text, verification_status, quote_span_start, source_document_id FROM message_citations ORDER BY id");
  return result.rows;
}

describe("the orchestrator's plain citation statuses are never written", () => {
  it("rejects an orchestrator citation's {status, spanStart, spanEnd} offered as the verification; accepts verify()'s own result", async () => {
    const message = await groundedMessage();
    // Exactly the shape runOrchestrator's final event carries — for a quote the document does NOT
    // contain, claiming verified.
    const plain: OrchestratorCitation = { quote: QUOTES.fabricated, sourceDocumentId: doc.id, status: "verified", spanStart: 0, spanEnd: 10 };
    const [real] = verifyMany([QUOTES.fabricated], doc.canonicalText!, doc.inputMode!);

    const forgeries: unknown[] = [plain, { status: "verified", spanStart: 0, spanEnd: 10 }, { ...real, status: "verified" }, { ...real }];
    for (const forged of forgeries) {
      await expect(
        insertCitations(h.t.db, userA, message.id, [
          { quote: QUOTES.fabricated, source: { documentId: doc.id, verification: forged as VerifyResult } },
        ]),
      ).rejects.toThrow("Not a VerifyResult issued by verify()");
    }
    expect(await storedRows()).toEqual([]);

    // Positive control: the result verify() issued for this quote and document is accepted.
    await insertCitations(h.t.db, userA, message.id, [{ quote: QUOTES.fabricated, source: { documentId: doc.id, verification: real } }]);
    expect(await storedRows()).toEqual([
      { quote_text: QUOTES.fabricated, verification_status: "not_found", quote_span_start: null, source_document_id: doc.id },
    ]);
  });
});

describe("a VerifyResult is bound to its quote, document text and input mode", () => {
  it("rejects a real result offered for another quote, another document's text, or the wrong input mode", async () => {
    const message = await groundedMessage();
    const otherText = `${LEASE}\n5. ${QUOTES.fabricated}.`;
    const other = await h.document(userA, otherText);
    const nativeDoc = await h.document(userA, LEASE, "native_document");

    const [forDeposit] = verifyMany([QUOTES.deposit], doc.canonicalText!, "text");
    // Verified against a text that does contain it — but not this document's text.
    const [againstOther] = verifyMany([QUOTES.fabricated], other.canonicalText!, "text");
    expect(againstOther.status).toBe("verified");
    // The native document's text, but computed as if it were a text document.
    const [asText] = verifyMany([QUOTES.deposit], nativeDoc.canonicalText!, "text");
    expect(asText.status).toBe("verified");

    const attempts = [
      { quote: QUOTES.lockIn, source: { documentId: doc.id, verification: forDeposit } },
      { quote: QUOTES.fabricated, source: { documentId: doc.id, verification: againstOther } },
      { quote: QUOTES.deposit, source: { documentId: nativeDoc.id, verification: asText } },
    ];
    for (const attempt of attempts) {
      await expect(insertCitations(h.t.db, userA, message.id, [attempt])).rejects.toThrow(
        "VerifyResult was computed for a different quote or document",
      );
    }
    expect(await storedRows()).toEqual([]);
  });
});

describe("the stored status is audit-only — every read re-verifies", () => {
  it("a stored status tampered to verified still reads not_found; one tampered to not_found still reads verified", async () => {
    const message = await groundedMessage();
    const [deposit, fabricated] = verifyMany([QUOTES.deposit, QUOTES.fabricated], doc.canonicalText!, "text");
    await insertCitations(h.t.db, userA, message.id, [
      { quote: QUOTES.deposit, source: { documentId: doc.id, verification: deposit } },
      { quote: QUOTES.fabricated, source: { documentId: doc.id, verification: fabricated } },
    ]);

    await h.t.client.query(
      "UPDATE message_citations SET verification_status = 'verified', quote_span_start = 0, quote_span_end = 12 WHERE quote_text = $1",
      [QUOTES.fabricated],
    );
    await h.t.client.query(
      "UPDATE message_citations SET verification_status = 'not_found', quote_span_start = NULL, quote_span_end = NULL WHERE quote_text = $1",
      [QUOTES.deposit],
    );
    // The tamper really landed.
    expect((await storedRows()).map((row) => [row.quote_text, row.verification_status])).toEqual([
      [QUOTES.deposit, "not_found"],
      [QUOTES.fabricated, "verified"],
    ]);

    const [readDeposit, readFabricated] = (await listVerifiedCitations(h.t.db, userA, thread.id, [message.id])).citations;
    expect(readFabricated.verification.status).toBe("not_found");
    expect(readFabricated.verification.spanStart).toBeNull();
    expect(readDeposit.verification.status).toBe("verified");
    expect(doc.canonicalText!.slice(readDeposit.verification.spanStart!, readDeposit.verification.spanEnd!)).toBe(QUOTES.deposit);
  });

  it("a verified citation whose document is deleted (ON DELETE SET NULL) reads not_found with no link", async () => {
    const message = await groundedMessage();
    const [deposit] = verifyMany([QUOTES.deposit], doc.canonicalText!, "text");
    await insertCitations(h.t.db, userA, message.id, [{ quote: QUOTES.deposit, source: { documentId: doc.id, verification: deposit } }]);
    const [before] = (await listVerifiedCitations(h.t.db, userA, thread.id, [message.id])).citations;
    expect(before.verification.status).toBe("verified");

    await h.t.client.query("DELETE FROM documents WHERE id = $1", [doc.id]);
    // The audit row survives, still saying verified — and is not what a reader gets.
    expect(await storedRows()).toEqual([
      { quote_text: QUOTES.deposit, verification_status: "verified", quote_span_start: before.verification.spanStart, source_document_id: null },
    ]);
    const [after] = (await listVerifiedCitations(h.t.db, userA, thread.id, [message.id])).citations;
    expect(after).toMatchObject({ quote: QUOTES.deposit, sourceDocumentId: null });
    expect(after.verification.status).toBe("not_found");
    expect(after.verification.spanStart).toBeNull();
  });
});

describe("a native_document citation never writes or reads verified", () => {
  it("an exact quote from a native_document is approximate on write and on read", async () => {
    const nativeDoc = await h.document(userA, LEASE, "native_document");
    const message = await groundedMessage();
    const [result] = verifyMany([QUOTES.deposit], nativeDoc.canonicalText!, "native_document");
    expect(result.status).toBe("approximate");
    await insertCitations(h.t.db, userA, message.id, [{ quote: QUOTES.deposit, source: { documentId: nativeDoc.id, verification: result } }]);
    expect((await storedRows())[0].verification_status).toBe("approximate");

    const [read] = (await listVerifiedCitations(h.t.db, userA, thread.id, [message.id])).citations;
    expect(read.verification.status).toBe("approximate");
    // Positive control: the same quote against the text-mode copy of the same text is verified.
    expect(verify({ quote: QUOTES.deposit, canonicalText: doc.canonicalText!, inputMode: "text" }).status).toBe("verified");
  });
});
