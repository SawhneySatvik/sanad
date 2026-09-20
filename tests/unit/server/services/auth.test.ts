// claimGuestSession's own orchestration rules, independent of the route (tests/integration/routes/
// claim.test.ts drives the real route end to end). Real PGlite throughout — the database is never
// mocked.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import { insertDocument } from "@tests/support/auth/claim";
import { claimGuestSession } from "@/server/services/auth";

const USER_ID = "5a5a5a5a-0000-4000-8000-00000000005a";
const user = { type: "user" as const, userId: USER_ID };
const guest = { type: "guest" as const, guestSessionId: "auth-service-guest" };

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  await t.db.insert(schema.users).values({ id: USER_ID, email: "claimer@example.com" });
});
afterEach(async () => {
  await t.close();
});

describe("claimGuestSession", () => {
  it("no signed-in user: VALIDATION_FAILED, and nothing moves", async () => {
    const document = await insertDocument(t, guest, new Date(Date.now() + 3_600_000));

    await expect(claimGuestSession({ db: t.db }, { user: null, guest })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    const [row] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, document.id));
    expect(row.ownerGuestSessionId).toBe(guest.guestSessionId);
    expect(row.ownerUserId).toBeNull();
  });

  it("no signed-in user, even with no guest session either: still VALIDATION_FAILED, and touches the database not at all (a missing user is checked first, before any guest/DB work)", async () => {
    // Same closed-db trick as the no-guest-session test below: proves the no-user branch queries
    // nothing, not just that it happens to reject.
    const dead = await createTestDb();
    await dead.close();
    await expect(claimGuestSession({ db: dead.db }, { user: null, guest: null })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("no valid guest session: zero counts, not an error, and touches the database not at all", async () => {
    // A db of its own, closed immediately: any query against it now throws (PGlite refuses a closed
    // connection), so the zero-count path resolving here proves it queries nothing — not just that
    // it happens to return zero rows. `t` (this file's shared fixture) is left alone for afterEach.
    const dead = await createTestDb();
    await dead.close();
    await expect(claimGuestSession({ db: dead.db }, { user, guest: null })).resolves.toEqual({
      documents: 0,
      comparisons: 0,
      drafts: 0,
    });
  });

  it("both present: delegates to the committed claimGuestData — the guest's rows become the user's", async () => {
    const document = await insertDocument(t, guest, new Date(Date.now() + 3_600_000));

    const result = await claimGuestSession({ db: t.db }, { user, guest });
    expect(result).toEqual({ documents: 1, comparisons: 0, drafts: 0 });

    const [row] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, document.id));
    expect(row).toMatchObject({ ownerUserId: USER_ID, ownerGuestSessionId: null, expiresAt: null });
  });
});
