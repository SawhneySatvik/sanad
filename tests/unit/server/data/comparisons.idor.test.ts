// Cross-principal access to the comparisons repository: a comparison associates two documents, so a
// foreign document on EITHER side — or a foreign comparison — is NOT_FOUND, indistinguishable from an
// id that does not exist or is malformed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@tests/support/db";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { createComparison, getComparableDocuments, getComparison } from "@/server/data/comparisons";
import { createRepoTestDb, guestA, guestB, pendingDocument, readyDocument, SAMPLE_TEXT, userA, userB } from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
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

async function comparisonCount(): Promise<number> {
  const result = await t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM comparisons");
  return result.rows[0].n;
}

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";
const MALFORMED_ID = "not-a-uuid";

describe.each<[string, Principal, Principal]>([
  ["user A using user B's document", userB, userA],
  ["guest A using guest B's document", guestB, guestA],
  ["a guest using a user's document", userA, guestA],
  ["a user using a guest's document", guestA, userA],
])("IDOR — %s", (_label, owner, intruder) => {
  it("createComparison with a foreign document on either side is NOT_FOUND, identical to a missing and a malformed id; nothing is written", async () => {
    const foreign = await readyDocument(t, owner, SAMPLE_TEXT);
    const own = await readyDocument(t, intruder, SAMPLE_TEXT);
    const attempt = (a: string, b: string) => caught(createComparison(t.db, intruder, { documentAId: a, documentBId: b, modelUsed: "test-model", changes: [] }));

    const reference = await attempt(own.id, foreign.id);
    expect(reference.code).toBe("NOT_FOUND");
    for (const [a, b] of [
      [foreign.id, own.id],
      [foreign.id, foreign.id],
      [own.id, MISSING_ID],
      [MISSING_ID, own.id],
      [own.id, MALFORMED_ID],
      [MALFORMED_ID, own.id],
    ]) {
      const error = await attempt(a, b);
      expect([error.code, error.message]).toEqual([reference.code, reference.message]);
    }
    expect(await comparisonCount()).toBe(0);

    // Positive control: the same principal with two documents of its own succeeds.
    const ownSecond = await readyDocument(t, intruder, SAMPLE_TEXT);
    await createComparison(t.db, intruder, { documentAId: own.id, documentBId: ownSecond.id, modelUsed: "test-model", changes: [] });
    expect(await comparisonCount()).toBe(1);
  });

  it("a foreign document that is not ready is NOT_FOUND, never INVALID_DOCUMENT (no existence oracle)", async () => {
    const foreignPending = await pendingDocument(t, owner);
    const own = await readyDocument(t, intruder, SAMPLE_TEXT);
    expect((await caught(createComparison(t.db, intruder, { documentAId: own.id, documentBId: foreignPending.id, modelUsed: "test-model", changes: [] }))).code).toBe(
      "NOT_FOUND",
    );
    expect((await caught(getComparableDocuments(t.db, intruder, foreignPending.id, own.id))).code).toBe("NOT_FOUND");
  });

  it("getComparableDocuments with a foreign document is NOT_FOUND; the owner reads both texts", async () => {
    const a = await readyDocument(t, owner, SAMPLE_TEXT);
    const b = await readyDocument(t, owner, SAMPLE_TEXT);
    const foreign = await caught(getComparableDocuments(t.db, intruder, a.id, b.id));
    const missing = await caught(getComparableDocuments(t.db, intruder, a.id, MISSING_ID));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);

    const own = await getComparableDocuments(t.db, owner, a.id, b.id);
    expect(own.documentA.canonicalText).toBe(a.canonicalText);
  });

  it("getComparison of the owner's comparison is NOT_FOUND, identical to a missing and a malformed id; the owner reads it", async () => {
    const a = await readyDocument(t, owner, SAMPLE_TEXT);
    const b = await readyDocument(t, owner, SAMPLE_TEXT);
    const { comparison } = await createComparison(t.db, owner, { documentAId: a.id, documentBId: b.id, modelUsed: "test-model", changes: [] });

    const foreign = await caught(getComparison(t.db, intruder, comparison.id));
    const missing = await caught(getComparison(t.db, intruder, MISSING_ID));
    const malformed = await caught(getComparison(t.db, intruder, MALFORMED_ID));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);

    expect((await getComparison(t.db, owner, comparison.id)).comparison.id).toBe(comparison.id);
  });
});
