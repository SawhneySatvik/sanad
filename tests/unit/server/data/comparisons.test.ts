// comparisons.ts is the only writer of comparison_changes. These tests pin what it persists and when
// it refuses. The verify() binding is pinned in comparisons.verify.test.ts, and cross-principal cases
// in comparisons.idor.test.ts.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { verify, VERIFIER_VERSION, type VerifyResult } from "@/server/deterministic/verify";
import { createComparison, getComparison, type ComparisonChangeWrite } from "@/server/data/comparisons";
import { DOCUMENT_GUEST_TTL_SECONDS, type Document } from "@/server/data/documents";
import {
  createRepoTestDb,
  guestA,
  pendingDocument,
  readyDocument,
  SAMPLE_TEXT,
  USER_A_ID,
  userA,
} from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

// SAMPLE_TEXT with clause 1's fee changed and a clause 3 added.
const TEXT_B =
  "1. The Licensee shall pay a monthly license fee of Rs. 35,000 on or before the 5th day of every month.\n" +
  "2. Either Party may terminate this Agreement by giving one month's prior written notice.\n" +
  "3. A lock-in period of six months applies.";
const FEE_A = "Rs. 32,000";
const FEE_B = "Rs. 35,000";
const LOCK_IN_B = "A lock-in period of six months applies.";

function checked(document: Document, quote: string): VerifyResult {
  return verify({ quote, canonicalText: document.canonicalText!, inputMode: document.inputMode! });
}

async function pair(principal: Principal = guestA) {
  return { a: await readyDocument(t, principal, SAMPLE_TEXT), b: await readyDocument(t, principal, TEXT_B) };
}

function writes(a: Document, b: Document): ComparisonChangeWrite[] {
  return [
    { changeType: "changed", explanation: "Fee rises.", quoteA: FEE_A, verificationA: checked(a, FEE_A), quoteB: FEE_B, verificationB: checked(b, FEE_B) },
    { changeType: "added", explanation: "Lock-in added.", quoteA: null, verificationA: null, quoteB: LOCK_IN_B, verificationB: checked(b, LOCK_IN_B) },
  ];
}

async function counts() {
  const result = await t.client.query<{ c: number; ch: number }>(
    "SELECT (SELECT count(*)::int FROM comparisons) AS c, (SELECT count(*)::int FROM comparison_changes) AS ch",
  );
  return { comparisons: result.rows[0].c, changes: result.rows[0].ch };
}

describe("createComparison — positive", () => {
  it("persists the comparison and its changes, with status, spans and verifier_version from each side's result alone", async () => {
    const { a, b } = await pair();
    const created = await createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: writes(a, b) });

    expect(created.comparison).toMatchObject({
      documentAId: a.id,
      documentBId: b.id,
      ownerGuestSessionId: "repo-guest-a",
      ownerUserId: null,
      projectId: null,
      modelUsed: "test-model",
    });
    const [fee, lockIn] = created.changes;
    const feeA = checked(a, FEE_A);
    const feeB = checked(b, FEE_B);
    expect(fee).toMatchObject({
      changeType: "changed",
      explanation: "Fee rises.",
      quoteTextA: FEE_A,
      docASpanStart: feeA.spanStart,
      docASpanEnd: feeA.spanEnd,
      verificationStatusA: "verified",
      quoteTextB: FEE_B,
      docBSpanStart: feeB.spanStart,
      docBSpanEnd: feeB.spanEnd,
      verificationStatusB: "verified",
      verifierVersion: VERIFIER_VERSION,
    });
    expect(a.canonicalText!.slice(fee.docASpanStart!, fee.docASpanEnd!)).toBe(FEE_A);
    expect(b.canonicalText!.slice(fee.docBSpanStart!, fee.docBSpanEnd!)).toBe(FEE_B);
    expect(lockIn).toMatchObject({
      changeType: "added",
      quoteTextA: null,
      docASpanStart: null,
      verificationStatusA: null,
      quoteTextB: LOCK_IN_B,
      verificationStatusB: "verified",
    });
    expect(await counts()).toEqual({ comparisons: 1, changes: 2 });
  });

  it("getComparison returns the changes in the order they were written", async () => {
    const { a, b } = await pair();
    const many: ComparisonChangeWrite[] = Array.from({ length: 12 }, (_, i) => ({
      changeType: "removed",
      explanation: `change ${i}`,
      quoteA: FEE_A,
      verificationA: checked(a, FEE_A),
      quoteB: null,
      verificationB: null,
    }));
    const created = await createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: many });
    const read = await getComparison(t.db, guestA, created.comparison.id);
    expect(read.comparison).toEqual(created.comparison);
    expect(read.changes.map((change) => change.explanation)).toEqual(many.map((change) => change.explanation));
    expect(read.changes).toEqual(created.changes);
  });

  it("a side that has a clause may carry no quote — and then no status, span or verifier version", async () => {
    const { a, b } = await pair();
    const { changes } = await createComparison(t.db, guestA, {
      documentAId: a.id,
      documentBId: b.id,
      modelUsed: "test-model",
      changes: [
        { ...writes(a, b)[0], quoteB: null, verificationB: null },
        { ...writes(a, b)[1], quoteB: null, verificationB: null },
      ],
    });
    expect(changes[0]).toMatchObject({ quoteTextA: FEE_A, verificationStatusA: "verified", quoteTextB: null, verificationStatusB: null, docBSpanStart: null });
    expect(changes[1]).toMatchObject({ quoteTextA: null, quoteTextB: null, verificationStatusB: null, verifierVersion: null });
  });

  it("a comparison with no changes is written on its own", async () => {
    const { a } = await pair();
    const copy = await readyDocument(t, guestA, SAMPLE_TEXT);
    const created = await createComparison(t.db, guestA, { documentAId: a.id, documentBId: copy.id, modelUsed: "test-model", changes: [] });
    expect(created.changes).toEqual([]);
    expect(await counts()).toEqual({ comparisons: 1, changes: 0 });
  });

  it("a user's comparison is owned by the user", async () => {
    const { a, b } = await pair(userA);
    const created = await createComparison(t.db, userA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [] });
    expect(created.comparison).toMatchObject({ ownerUserId: USER_A_ID, ownerGuestSessionId: null, expiresAt: null });
  });
});

describe("expires_at — never later than either document", () => {
  async function setExpiry(document: Document, expiresAt: Date | null) {
    await t.db.update(schema.documents).set({ expiresAt }).where(eq(schema.documents.id, document.id));
  }

  it.each([
    ["A expires first", 60, 120],
    ["B expires first", 120, 60],
  ])("a guest comparison expires exactly when the earlier document does (%s)", async (_label, minutesA, minutesB) => {
    const { a, b } = await pair();
    const expiresA = new Date(Date.now() + minutesA * 60_000);
    const expiresB = new Date(Date.now() + minutesB * 60_000);
    await setExpiry(a, expiresA);
    await setExpiry(b, expiresB);

    const { comparison } = await createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [] });
    const earlier = minutesA < minutesB ? expiresA : expiresB;
    expect(comparison.expiresAt!.getTime()).toBe(earlier.getTime());
    const [stored] = await t.client.query<{ ok: boolean }>(
      "SELECT c.expires_at = LEAST(a.expires_at, b.expires_at) AS ok FROM comparisons c JOIN documents a ON a.id = c.document_a_id JOIN documents b ON b.id = c.document_b_id",
    ).then((r) => r.rows);
    expect(stored.ok).toBe(true);
  });

  it("a guest comparison never outlives a guest document's TTL from now", async () => {
    const { a, b } = await pair();
    await setExpiry(a, new Date(Date.now() + 10 * 3_600_000));
    await setExpiry(b, new Date(Date.now() + 11 * 3_600_000));
    const before = Date.now();
    const { comparison } = await createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [] });
    const after = Date.now();
    expect(comparison.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + DOCUMENT_GUEST_TTL_SECONDS * 1000);
    expect(comparison.expiresAt!.getTime()).toBeLessThanOrEqual(after + DOCUMENT_GUEST_TTL_SECONDS * 1000);
  });

  it("a user's comparison of non-expiring documents never expires; one expiring document caps it", async () => {
    const { a, b } = await pair(userA);
    expect([a.expiresAt, b.expiresAt]).toEqual([null, null]);
    const open = await createComparison(t.db, userA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [] });
    expect(open.comparison.expiresAt).toBeNull();

    const expiresB = new Date(Date.now() + 30 * 60_000);
    await setExpiry(b, expiresB);
    const capped = await createComparison(t.db, userA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [] });
    expect(capped.comparison.expiresAt!.getTime()).toBe(expiresB.getTime());
  });
});

describe("createComparison — refusals write nothing", () => {
  it("a document that is not ready is INVALID_DOCUMENT", async () => {
    const { a } = await pair();
    const pending = await pendingDocument(t, guestA);
    await expect(createComparison(t.db, guestA, { documentAId: a.id, documentBId: pending.id, modelUsed: "test-model", changes: [] })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "document_not_ready",
    });
    await expect(createComparison(t.db, guestA, { documentAId: pending.id, documentBId: a.id, modelUsed: "test-model", changes: [] })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "document_not_ready",
    });
    expect(await counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it.each<[string, (a: Document, b: Document) => ComparisonChangeWrite, RegExp]>([
    [
      "an added change quoting side A",
      (a, b) => ({ ...writes(a, b)[1], quoteA: FEE_A, verificationA: checked(a, FEE_A) }),
      /A "added" comparison change has a quote on a side it has no clause on/,
    ],
    [
      "a removed change quoting side B",
      (a, b) => ({ ...writes(a, b)[0], changeType: "removed" }),
      /A "removed" comparison change has a quote on a side it has no clause on/,
    ],
    ["a quote with no verification result", (a, b) => ({ ...writes(a, b)[0], verificationA: null }), /Not a VerifyResult issued by verify\(\)/],
    [
      "a verification result with no quote",
      (a, b) => ({ ...writes(a, b)[1], verificationA: checked(a, FEE_A) }),
      /A comparison side without a quote cannot carry a verification result/,
    ],
  ])("%s throws its own error", async (_label, build, message) => {
    const { a, b } = await pair();
    const good = writes(a, b)[0];
    await expect(
      createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [good, build(a, b)] }),
    ).rejects.toThrow(message);
    expect(await counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it("a blank model_used is refused by the database", async () => {
    const { a, b } = await pair();
    await expect(
      createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "  ", changes: [] }),
    ).rejects.toSatisfy((error: unknown) => String((error as Error).cause).includes("comparisons_model_used_not_blank_check"));
    expect(await counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it("a database failure on the last insert rolls back the comparison row too", async () => {
    const { a, b } = await pair();
    await t.client.exec("ALTER TABLE comparison_changes ADD CONSTRAINT test_reject_every_row CHECK (false)");
    await expect(
      createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: writes(a, b) }),
    ).rejects.toSatisfy((error: unknown) => String((error as Error).cause).includes("test_reject_every_row"));
    expect(await counts()).toEqual({ comparisons: 0, changes: 0 });

    await t.client.exec("ALTER TABLE comparison_changes DROP CONSTRAINT test_reject_every_row");
    await createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: writes(a, b) });
    expect(await counts()).toEqual({ comparisons: 1, changes: 2 });
  });
});
