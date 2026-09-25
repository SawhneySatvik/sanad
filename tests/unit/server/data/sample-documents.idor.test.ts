// Cross-principal access to the sample-documents repository (src/server/data/sample-documents.ts).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@tests/support/db";
import { findOrInsertSampleDocument, findOwnedSampleDocument } from "@/server/data/sample-documents";
import { caught, createRepoTestDb, guestA, guestB, refFor, userA, userB, USER_B_ID } from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

function inputFor(principal: Parameters<typeof refFor>[0], sampleId = "lease") {
  return { sampleId, storageRef: refFor(principal), filename: "lease.txt", mimeType: "text/plain" };
}

describe("findOwnedSampleDocument", () => {
  it("a foreign signed-in principal never sees another user's sample copy", async () => {
    const inserted = await findOrInsertSampleDocument(t.db, userA, inputFor(userA));
    expect(inserted.created).toBe(true);

    expect(await findOwnedSampleDocument(t.db, userB, "lease")).toBeNull();
    expect(await findOwnedSampleDocument(t.db, userA, "lease")).toEqual({ id: inserted.id });
  });

  it("a foreign guest never sees another guest's sample copy", async () => {
    const inserted = await findOrInsertSampleDocument(t.db, guestA, inputFor(guestA));

    expect(await findOwnedSampleDocument(t.db, guestB, "lease")).toBeNull();
    expect(await findOwnedSampleDocument(t.db, guestA, "lease")).toEqual({ id: inserted.id });
  });

  it("never returns a copy of a different sample id", async () => {
    await findOrInsertSampleDocument(t.db, userA, inputFor(userA, "lease"));
    expect(await findOwnedSampleDocument(t.db, userA, "nda")).toBeNull();
  });

  // ownerFilter (the WHERE clause) is what makes the query return only the caller's own row in the
  // first place; canAccess is belt-and-suspenders on top of it. This is the case where that ordering
  // matters: without ownerFilter, a foreign principal's NEWER row would win the query's
  // `ORDER BY updated_at DESC LIMIT 1`, canAccess would (correctly) reject that wrong row, and the
  // caller's own existing copy would be reported missing — silently inserting a second row for a
  // principal who already has one, never a cross-principal read (canAccess still catches that part).
  it("a foreign principal's newer row for the same sample never displaces the caller's own, older one", async () => {
    const mine = await findOrInsertSampleDocument(t.db, userA, inputFor(userA));
    await findOrInsertSampleDocument(t.db, userB, inputFor(userB));
    // Make userB's row sort first under "newest activity first" ordering.
    await t.client.query("UPDATE documents SET updated_at = now() + interval '1 hour' WHERE owner_user_id = $1", [USER_B_ID]);

    expect(await findOwnedSampleDocument(t.db, userA, "lease")).toEqual({ id: mine.id });
    const reopened = await findOrInsertSampleDocument(t.db, userA, inputFor(userA));
    expect(reopened).toEqual({ id: mine.id, created: false });
  });
});

describe("findOrInsertSampleDocument", () => {
  it("two different principals opening the same sample id get two different rows, never each other's", async () => {
    const a = await findOrInsertSampleDocument(t.db, userA, inputFor(userA));
    const b = await findOrInsertSampleDocument(t.db, userB, inputFor(userB));

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  it("re-inserting for the same principal returns the existing row, never a fresh or foreign one", async () => {
    const first = await findOrInsertSampleDocument(t.db, userA, inputFor(userA));
    const second = await findOrInsertSampleDocument(t.db, userA, inputFor(userA));

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("a storageRef minted for a foreign principal is refused (NOT_FOUND), never silently reassigned", async () => {
    const error = await caught(findOrInsertSampleDocument(t.db, userA, inputFor(userB)));
    expect(error.code).toBe("NOT_FOUND");
  });
});
