// The claim-vs-sweep race: claimGuestData against the real M4 sweep — every row ends up either
// claimed or deleted, never both, never neither. ORDERING tests, not interleavings (PGlite is one
// connection); real row-lock interleaving is scripts/pg-race-claim.ts, not part of npm test.

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@tests/support/db";
import { getDocumentSummary } from "@/server/data/documents";
import { claimGuestData } from "@/server/auth/claim";
import {
  allFates,
  createClaimTestDb,
  draftsGroundedOnGuestDocuments,
  fates,
  guest,
  insertGuestSet,
  minutesFromNow,
  strandedReferences,
  sweep,
  user,
  type GuestSet,
} from "@tests/support/auth/claim";

let t: TestDb;
beforeEach(async () => {
  t = await createClaimTestDb();
});
afterEach(async () => {
  await t.close();
});

const LIVE_SET_COUNTS = { documents: 2, comparisons: 1, drafts: 3 };
const NOTHING = { documents: 0, comparisons: 0, drafts: 0 };

async function expiredByDbClock(documentId: string): Promise<boolean> {
  const result = await t.client.query<{ past: boolean }>("SELECT now() > expires_at AS past FROM documents WHERE id = $1", [documentId]);
  return result.rows[0].past;
}

function refs(set: GuestSet): string[] {
  return set.documents.map((d) => d.storageRef).sort();
}

async function expectExactlyOneOutcome(live: GuestSet, expired: GuestSet) {
  expect(await fates(t, live)).toEqual(allFates(live, "claimed"));
  expect(await fates(t, expired)).toEqual(allFates(expired, "deleted"));
  expect(await strandedReferences(t)).toBe(0);
  expect(await draftsGroundedOnGuestDocuments(t)).toBe(0);
}

describe("claim vs the real TTL sweep (TOCTOU)", () => {
  it("sweep first, then claim: the sweep deletes only the expired set; the claim then re-owns only the live one", async () => {
    const live = await insertGuestSet(t, guest, minutesFromNow(60));
    const expired = await insertGuestSet(t, guest, minutesFromNow(-1));

    expect(await sweep(t)).toEqual(refs(expired));
    expect(await fates(t, live)).toEqual(allFates(live, "guest-owned"));
    expect(await claimGuestData(t.db, guest, user)).toEqual(LIVE_SET_COUNTS);

    await expectExactlyOneOutcome(live, expired);
  });

  it("claim first, then sweep: the claim's in-transaction re-check declines the expired-but-unswept set, which the sweep then deletes", async () => {
    const live = await insertGuestSet(t, guest, minutesFromNow(60));
    const expired = await insertGuestSet(t, guest, minutesFromNow(-1));

    expect(await claimGuestData(t.db, guest, user)).toEqual(LIVE_SET_COUNTS);
    expect(await fates(t, expired)).toEqual(allFates(expired, "guest-owned"));
    // The sweep's own delete-time re-check skips every row the claim re-owned.
    expect(await sweep(t)).toEqual(refs(expired));

    await expectExactlyOneOutcome(live, expired);
  });

  it("a set the guest saw live expires before the claim runs: the claim declines it and the sweep deletes it", async () => {
    const live = await insertGuestSet(t, guest, minutesFromNow(60));
    const expiring = await insertGuestSet(t, guest, minutesFromNow(60));

    // The selection: the guest's own read shows the document live.
    const seen = await getDocumentSummary(t.db, guest, expiring.documents[0].id);
    expect(seen.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    // Only now is the set's shared expiry pulled in, so the read above never races slow inserts.
    const ids = [...expiring.documents, expiring.comparison, ...expiring.drafts].map((row) => row.id);
    await t.client.query(
      `WITH e AS (SELECT now() + interval '300 milliseconds' AS e),
            d AS (UPDATE documents SET expires_at = (SELECT e FROM e) WHERE id = ANY($1::uuid[])),
            c AS (UPDATE comparisons SET expires_at = (SELECT e FROM e) WHERE id = ANY($1::uuid[]))
       UPDATE drafts SET expires_at = (SELECT e FROM e) WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    // It expires, by the database's clock (compared in SQL, at full precision), before the claim's
    // transaction starts.
    while (!(await expiredByDbClock(expiring.documents[0].id))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(await claimGuestData(t.db, guest, user)).toEqual(LIVE_SET_COUNTS);
    expect(await sweep(t)).toEqual(refs(expiring));
    await expectExactlyOneOutcome(live, expiring);
  });

  describe("exact-tie boundary: every row of the set shares one expires_at, as LEAST() and chain inheritance produce", () => {
    // The outer transaction pins now(): claimGuestData runs inside it (as a savepoint), so its re-check
    // sees exactly the instant the rows were stamped with.
    async function claimAt(offset: "now()" | "now() + interval '1 microsecond'") {
      return t.db.transaction(async (tx) => {
        for (const table of ["documents", "comparisons", "drafts"]) {
          await tx.execute(sql.raw(`UPDATE ${table} SET expires_at = ${offset} WHERE owner_guest_session_id = '${guest.guestSessionId}'`));
        }
        return claimGuestData(tx, guest, user);
      });
    }

    it("expires_at = the claim's now(): all three tables decline every row alike, and the next sweep deletes the whole set", async () => {
      const set = await insertGuestSet(t, guest, minutesFromNow(60));

      expect(await claimAt("now()")).toEqual(NOTHING);
      expect(await fates(t, set)).toEqual(allFates(set, "guest-owned"));
      expect(await strandedReferences(t)).toBe(0);
      expect(await draftsGroundedOnGuestDocuments(t)).toBe(0);

      // A later transaction's now() is past the tie, so the sweep takes the set; nothing is left behind.
      expect(await sweep(t)).toEqual(refs(set));
      expect(await fates(t, set)).toEqual(allFates(set, "deleted"));
    });

    it("expires_at one microsecond after the claim's now(): every row is claimed alike, and the sweep leaves them", async () => {
      const set = await insertGuestSet(t, guest, minutesFromNow(60));

      expect(await claimAt("now() + interval '1 microsecond'")).toEqual(LIVE_SET_COUNTS);
      expect(await sweep(t)).toEqual([]);
      expect(await fates(t, set)).toEqual(allFates(set, "claimed"));
      expect(await strandedReferences(t)).toBe(0);
    });
  });
});
