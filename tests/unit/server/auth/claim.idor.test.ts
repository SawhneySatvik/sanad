// Cross-principal behaviour of the guest → user claim: a claim moves exactly the claiming guest's
// rows to exactly the claiming user, and afterwards the old guest is denied everything it used to
// own, the same NOT_FOUND as an id that never existed.

import { asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { canAccess } from "@/server/data/access";
import { getDocumentSummary } from "@/server/data/documents";
import { claimGuestData } from "@/server/auth/claim";
import {
  allFates,
  createClaimTestDb,
  fates,
  guest,
  insertDocument,
  insertDraftChain,
  insertGuestSet,
  minutesFromNow,
  otherGuest,
  otherUser,
  OTHER_USER_ID,
  user,
} from "@tests/support/auth/claim";

let t: TestDb;
beforeEach(async () => {
  t = await createClaimTestDb();
});
afterEach(async () => {
  await t.close();
});

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";

describe("claim IDOR", () => {
  it("re-owns only the claiming guest's rows: another guest's rows and every user's pre-existing rows are untouched", async () => {
    const mine = await insertGuestSet(t, guest, minutesFromNow(60));
    const otherGuests = await insertGuestSet(t, otherGuest, minutesFromNow(60));
    const usersOwnDocument = await insertDocument(t, user, null);
    const usersOwnDrafts = await insertDraftChain(t, user, null, usersOwnDocument.id, 2);
    const otherUsersDocument = await insertDocument(t, otherUser, null);
    const untouchedBefore = await t.db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, otherUsersDocument.id));

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 2, comparisons: 1, drafts: 3 });

    // Positive control: the claiming guest's set moved.
    expect(await fates(t, mine)).toEqual(allFates(mine, "claimed"));
    // Another guest's identical set did not.
    expect(await fates(t, otherGuests)).toEqual(allFates(otherGuests, "guest-owned"));
    for (const row of otherGuests.documents) {
      const [after] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, row.id));
      expect(after).toEqual(row);
    }
    // The user's own rows and another user's rows are exactly as they were.
    expect(await t.db.select().from(schema.documents).where(eq(schema.documents.id, usersOwnDocument.id))).toEqual([usersOwnDocument]);
    const draftIds = usersOwnDrafts.map((d) => d.id);
    expect(
      await t.db.select().from(schema.drafts).where(inArray(schema.drafts.id, draftIds)).orderBy(asc(schema.drafts.revisionNumber)),
    ).toEqual(usersOwnDrafts);
    expect(await t.db.select().from(schema.documents).where(eq(schema.documents.id, otherUsersDocument.id))).toEqual(untouchedBefore);
    // Nothing went to the other user.
    expect(await t.db.select().from(schema.documents).where(eq(schema.documents.ownerUserId, OTHER_USER_ID))).toHaveLength(1);
  });

  it("afterwards the old guest gets the same NOT_FOUND as a missing id on every claimed row; the user reads them", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));
    const missing = await getDocumentSummary(t.db, guest, MISSING_ID).catch((e: Error) => e);

    await claimGuestData(t.db, guest, user);

    for (const document of set.documents) {
      const denied = await getDocumentSummary(t.db, guest, document.id).catch((e: Error) => e);
      expect(denied).toEqual(missing);
      await expect(getDocumentSummary(t.db, user, document.id)).resolves.toMatchObject({ id: document.id });
      // Another user is still denied.
      await expect(getDocumentSummary(t.db, otherUser, document.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    for (const row of [...(await t.db.select().from(schema.comparisons)), ...(await t.db.select().from(schema.drafts))]) {
      expect(canAccess(user, row)).toBe(true);
      expect(canAccess(guest, row)).toBe(false);
      expect(canAccess(otherUser, row)).toBe(false);
    }
  });

  it("claiming a guest's data for one user leaves nothing for a second user to claim", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));

    await claimGuestData(t.db, guest, user);
    expect(await claimGuestData(t.db, guest, otherUser)).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
    expect(await fates(t, set)).toEqual(allFates(set, "claimed"));
  });
});
