// Cross-principal access to the Compare service: a comparison associates two documents, so a document
// that exists but belongs to someone else — on either side — is NOT_FOUND, indistinguishable from one
// that does not exist, and the model is never called with its text.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { AppError, httpStatusFor } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { compare, get } from "@/server/services/compare";
import {
  type CompareHarness,
  createCompareHarness,
  explainAll,
  guestA,
  guestB,
  LEASE_A,
  LEASE_B,
  USER_B_ID,
  userA,
  userB,
} from "@tests/support/services/compare";

let h: CompareHarness;
beforeEach(async () => {
  h = await createCompareHarness();
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

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";
const MALFORMED_ID = "not-a-uuid";

it("user A cannot create a comparison using user B's document ID", async () => {
  const ownDocument = await h.document(userA, LEASE_A);
  const userBDocument = await h.document(userB, LEASE_B);
  const userBSecond = await h.document(userB, LEASE_A);
  const llm = new FakeLlmClient({ defaultResponse: explainAll() });
  const attempt = (documentAId: string, documentBId: string) => caught(compare(h.deps(llm), userA, { documentAId, documentBId }));

  const error = await attempt(ownDocument.id, userBDocument.id);
  expect(error.code).toBe("NOT_FOUND");
  expect(httpStatusFor(error.code)).toBe(404);
  // Identical to user B's document on the other side, user B's documents on both sides, a missing id
  // and a malformed id.
  for (const [a, b] of [
    [userBDocument.id, ownDocument.id],
    [userBDocument.id, userBSecond.id],
    [ownDocument.id, MISSING_ID],
    [ownDocument.id, MALFORMED_ID],
  ]) {
    const other = await attempt(a, b);
    expect([other.code, other.message]).toEqual([error.code, error.message]);
  }
  expect(llm.callCount).toBe(0);
  expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });

  // Positive control: the same principal comparing two documents of its own succeeds.
  const ownSecond = await h.document(userA, LEASE_B);
  const result = await compare(h.deps(llm), userA, { documentAId: ownDocument.id, documentBId: ownSecond.id });
  expect(result.changes).toHaveLength(4);
  expect(llm.callCount).toBe(1);
  expect(await h.counts()).toEqual({ comparisons: 1, changes: 4 });
});

describe.each<[string, Principal, Principal]>([
  ["user B reading user A's comparison", userA, userB],
  ["guest B reading guest A's comparison", guestA, guestB],
  ["a user reading a guest's comparison", guestA, userA],
  ["a guest reading a user's comparison", userA, guestA],
])("IDOR — %s", (_label, owner, intruder) => {
  it("get() is NOT_FOUND, identical to a missing and a malformed id; the owner still reads it", async () => {
    const a = await h.document(owner, LEASE_A);
    const b = await h.document(owner, LEASE_B);
    const created = await compare(h.deps(new FakeLlmClient({ defaultResponse: explainAll() })), owner, {
      documentAId: a.id,
      documentBId: b.id,
    });
    const deps = h.deps(new FakeLlmClient());

    const foreign = await caught(get(deps, intruder, created.comparison.id));
    const missing = await caught(get(deps, intruder, MISSING_ID));
    const malformed = await caught(get(deps, intruder, MALFORMED_ID));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);

    const own = await get(deps, owner, created.comparison.id);
    expect(own.changes).toHaveLength(4);
  });

  it("compare() with the owner's document on either side is NOT_FOUND and never reaches the model", async () => {
    const foreign = await h.document(owner, LEASE_A);
    const own = await h.document(intruder, LEASE_B);
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    for (const [a, b] of [
      [own.id, foreign.id],
      [foreign.id, own.id],
    ]) {
      expect((await caught(compare(h.deps(llm), intruder, { documentAId: a, documentBId: b }))).code).toBe("NOT_FOUND");
    }
    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });
  });
});

it("get() re-checks both documents: a comparison whose document now belongs to someone else is NOT_FOUND", async () => {
  const a = await h.document(guestA, LEASE_A);
  const b = await h.document(guestA, LEASE_B);
  const created = await compare(h.deps(new FakeLlmClient({ defaultResponse: explainAll() })), guestA, {
    documentAId: a.id,
    documentBId: b.id,
  });
  const deps = h.deps(new FakeLlmClient());
  expect((await get(deps, guestA, created.comparison.id)).changes).toHaveLength(4);

  await h.t.db
    .update(schema.documents)
    .set({ ownerGuestSessionId: null, ownerUserId: USER_B_ID, expiresAt: null })
    .where(eq(schema.documents.id, b.id));
  expect((await caught(get(deps, guestA, created.comparison.id))).code).toBe("NOT_FOUND");
});
