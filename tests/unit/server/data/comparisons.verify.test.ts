// One Guarantee at the comparison_changes write path: a side's status is persisted only from the
// VerifyResult verify() issued for exactly that side's quote, against exactly that side's document
// text and input mode.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { verify, type VerifyResult } from "@/server/deterministic/verify";
import { createComparison, type ComparisonChangeWrite } from "@/server/data/comparisons";
import type { Document } from "@/server/data/documents";
import { createRepoTestDb, guestA, readyDocument, SAMPLE_TEXT } from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

const TEXT_B =
  "1. The Licensee shall pay a monthly license fee of Rs. 35,000 on or before the 5th day of every month.\n" +
  "2. Either Party may terminate this Agreement by giving one month's prior written notice.";
const FEE_A = "Rs. 32,000";
const FEE_B = "Rs. 35,000";
// Word for word in both documents, at the same offset.
const SHARED = "Either Party may terminate this Agreement";

function checked(document: Document, quote: string, inputMode = document.inputMode!): VerifyResult {
  return verify({ quote, canonicalText: document.canonicalText!, inputMode });
}

function changed(a: Document, b: Document, sides: Partial<ComparisonChangeWrite> = {}): ComparisonChangeWrite {
  return {
    changeType: "changed",
    explanation: "e",
    quoteA: FEE_A,
    verificationA: checked(a, FEE_A),
    quoteB: FEE_B,
    verificationB: checked(b, FEE_B),
    ...sides,
  };
}

async function rowCount(): Promise<number> {
  const result = await t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM comparisons");
  return result.rows[0].n;
}

// The messages of a rejection and its cause chain (drizzle wraps the Postgres error).
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(" | ");
  }
  throw new Error("expected a rejection");
}

describe("each side is bound to its own quote and its own document", () => {
  it("positive: each side's own result is accepted and stored exactly as verify() issued it", async () => {
    const a = await readyDocument(t, guestA, SAMPLE_TEXT);
    const b = await readyDocument(t, guestA, TEXT_B);
    const { changes } = await createComparison(t.db, guestA, {
      documentAId: a.id,
      documentBId: b.id,
      modelUsed: "test-model",
      changes: [changed(a, b, { quoteA: SHARED, verificationA: checked(a, SHARED), quoteB: SHARED, verificationB: checked(b, SHARED) })],
    });
    expect([changes[0].verificationStatusA, changes[0].verificationStatusB]).toEqual(["verified", "verified"]);
  });

  it("negative: an A/B swap — side A's result offered for side B and vice versa — throws and writes nothing", async () => {
    const a = await readyDocument(t, guestA, SAMPLE_TEXT);
    const b = await readyDocument(t, guestA, TEXT_B);
    const swapped = changed(a, b, { verificationA: checked(b, FEE_B), verificationB: checked(a, FEE_A) });
    await expect(createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [swapped] })).rejects.toThrow(
      /computed for a different quote or document/,
    );
    expect(await rowCount()).toBe(0);
  });

  it("negative: the right quote verified against the other side's document throws — the document binding alone catches it", async () => {
    const a = await readyDocument(t, guestA, SAMPLE_TEXT);
    const b = await readyDocument(t, guestA, TEXT_B);
    // Same quote, same offsets, same status: only the document differs.
    expect(checked(b, SHARED).spanStart).toBe(checked(a, SHARED).spanStart);
    const wrongDocument = changed(a, b, { quoteA: SHARED, verificationA: checked(b, SHARED), quoteB: SHARED, verificationB: checked(b, SHARED) });
    await expect(createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [wrongDocument] })).rejects.toThrow(
      /computed for a different quote or document/,
    );
    expect(await rowCount()).toBe(0);
  });

  it("negative: a result for a different quote throws", async () => {
    const a = await readyDocument(t, guestA, SAMPLE_TEXT);
    const b = await readyDocument(t, guestA, TEXT_B);
    const otherQuote = changed(a, b, { verificationA: checked(a, SHARED) });
    await expect(createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [otherQuote] })).rejects.toThrow(
      /computed for a different quote or document/,
    );
    expect(await rowCount()).toBe(0);
  });

  it("negative: a forged result — a plain object, or a spread of a real one — throws", async () => {
    const a = await readyDocument(t, guestA, SAMPLE_TEXT);
    const b = await readyDocument(t, guestA, TEXT_B);
    const real = checked(a, FEE_A);
    const plain = { ...real, status: "verified", spanStart: 0, spanEnd: 3 } as unknown as VerifyResult;
    const literal = {
      status: "verified",
      spanStart: 0,
      spanEnd: 3,
      quote: FEE_A,
      canonicalTextHash: a.canonicalTextHash,
      inputMode: "text",
      verifierVersion: real.verifierVersion,
    } as unknown as VerifyResult;
    for (const forged of [plain, literal]) {
      await expect(
        createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [changed(a, b, { verificationA: forged })] }),
      ).rejects.toThrow(/Not a VerifyResult issued by verify\(\)/);
    }
    expect(await rowCount()).toBe(0);
  });

  it("a quote absent from its document is stored not_found, with no span", async () => {
    const a = await readyDocument(t, guestA, SAMPLE_TEXT);
    const b = await readyDocument(t, guestA, TEXT_B);
    const absent = "The Licensee may sublet the premises";
    const { changes } = await createComparison(t.db, guestA, {
      documentAId: a.id,
      documentBId: b.id,
      modelUsed: "test-model",
      changes: [changed(a, b, { quoteB: absent, verificationB: checked(b, absent) })],
    });
    expect(changes[0]).toMatchObject({ quoteTextB: absent, verificationStatusB: "not_found", docBSpanStart: null, docBSpanEnd: null });
  });
});

describe.each<["A" | "B"]>([["A"], ["B"]])("a native_document side is never verified (native on side %s)", (nativeSide) => {
  async function documents() {
    return {
      a: await readyDocument(t, guestA, SAMPLE_TEXT, nativeSide === "A" ? "native_document" : "text"),
      b: await readyDocument(t, guestA, TEXT_B, nativeSide === "B" ? "native_document" : "text"),
    };
  }

  it("negative: a result computed as 'text' over a native_document's transcription throws", async () => {
    const { a, b } = await documents();
    const passedAsText = nativeSide === "A" ? checked(a, FEE_A, "text") : checked(b, FEE_B, "text");
    expect(passedAsText.status).toBe("verified");
    const change = changed(a, b, nativeSide === "A" ? { verificationA: passedAsText } : { verificationB: passedAsText });
    await expect(
      createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [change] }),
    ).rejects.toThrow(/computed for a different quote or document/);
    expect(await rowCount()).toBe(0);
  });

  it("the native side is stored approximate, the text side verified — and the database refuses a verified native side", async () => {
    const { a, b } = await documents();
    const { changes } = await createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [changed(a, b)] });
    expect([changes[0].verificationStatusA, changes[0].verificationStatusB]).toEqual(
      nativeSide === "A" ? ["approximate", "verified"] : ["verified", "approximate"],
    );

    // The persistence backstop (comparison_changes_native_document_verified_ceiling).
    const forced = t.db
      .update(schema.comparisonChanges)
      .set(nativeSide === "A" ? { verificationStatusA: "verified" } : { verificationStatusB: "verified" })
      .where(eq(schema.comparisonChanges.id, changes[0].id))
      .then(() => undefined);
    expect(await rejectionText(forced)).toMatch(new RegExp(`side ${nativeSide} cannot be verified`));
  });
});
