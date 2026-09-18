// claimGuestData: what it re-owns, what it leaves alone, and that it is one transaction. The race
// against the real TTL sweep is in claim.toctou.test.ts; cross-principal checks in claim.idor.test.ts.

import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { canAccess } from "@/server/data/access";
import { getDocumentSummary } from "@/server/data/documents";
import { refBelongsTo } from "@/server/storage/refs";
import { claimGuestData, sweepOrderOfDrafts, type GuestPrincipal, type UserPrincipal } from "@/server/auth/claim";
import {
  allFates,
  createClaimTestDb,
  draftsGroundedOnGuestDocuments,
  fates,
  guest,
  insertComparison,
  insertDocument,
  insertDraftChain,
  insertGuestSet,
  minutesFromNow,
  strandedReferences,
  sweep,
  user,
  USER_ID,
} from "@tests/support/auth/claim";

let t: TestDb;
beforeEach(async () => {
  t = await createClaimTestDb();
});
afterEach(async () => {
  await t.close();
});

async function snapshot(db: TestDb) {
  return {
    documents: await db.db.select().from(schema.documents).orderBy(asc(schema.documents.id)),
    comparisons: await db.db.select().from(schema.comparisons).orderBy(asc(schema.comparisons.id)),
    drafts: await db.db.select().from(schema.drafts).orderBy(asc(schema.drafts.id)),
    findings: await db.db.select().from(schema.findings).orderBy(asc(schema.findings.id)),
    comparisonChanges: await db.db.select().from(schema.comparisonChanges).orderBy(asc(schema.comparisonChanges.id)),
  };
}

describe("claimGuestData", () => {
  it("re-owns the guest's live documents, comparison and whole draft chain to the user and clears every expires_at", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 2, comparisons: 1, drafts: 3 });

    expect(await fates(t, set)).toEqual(allFates(set, "claimed"));
    const claimedDrafts = await t.db.select().from(schema.drafts).orderBy(asc(schema.drafts.revisionNumber));
    // The chain and its grounding survive intact.
    expect(claimedDrafts.map((d) => d.parentDraftId)).toEqual([null, set.drafts[0].id, set.drafts[1].id]);
    expect(claimedDrafts.every((d) => d.groundingDocumentId === set.documents[0].id)).toBe(true);
    expect(await strandedReferences(t)).toBe(0);
    expect(await draftsGroundedOnGuestDocuments(t)).toBe(0);
  });

  it("keeps each document's guest: storage_ref byte-for-byte; access follows the row's owner, not the ref", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));
    await claimGuestData(t.db, guest, user);

    for (const before of set.documents) {
      const [after] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, before.id));
      expect(after.storageRef).toBe(before.storageRef);
      expect(after.storageRef.startsWith("guest:claiming-guest/")).toBe(true);
      // The ref still names the guest...
      expect(refBelongsTo(after.storageRef, user)).toBe(false);
      // ...but the row is the user's now, and only the user's.
      await expect(getDocumentSummary(t.db, user, before.id)).resolves.toMatchObject({ id: before.id, ownerUserId: USER_ID });
      await expect(getDocumentSummary(t.db, guest, before.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const [comparison] = await t.db.select().from(schema.comparisons);
    expect(canAccess(user, comparison)).toBe(true);
    expect(canAccess(guest, comparison)).toBe(false);
    for (const draft of await t.db.select().from(schema.drafts)) {
      expect(canAccess(user, draft)).toBe(true);
      expect(canAccess(guest, draft)).toBe(false);
    }
  });

  it("is idempotent: a second claim returns zeros and changes nothing", async () => {
    await insertGuestSet(t, guest, minutesFromNow(60));
    await claimGuestData(t.db, guest, user);
    const before = await snapshot(t);

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
    expect(await snapshot(t)).toEqual(before);
  });

  it("a guest with nothing left to claim gets zeros", async () => {
    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
  });

  it("never writes a verification column (One Guarantee): findings and comparison changes are unchanged", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));
    const [analysis] = await t.db
      .insert(schema.analyses)
      .values({ documentId: set.documents[0].id, promptVersion: "p", modelUsed: "gemini-test" })
      .returning();
    // Audit rows inserted directly as fixtures: the test only needs values to compare, not a verify() run.
    await t.db.insert(schema.findings).values([
      {
        documentId: set.documents[0].id,
        analysisId: analysis.id,
        category: "obligation",
        quoteText: "pay rent",
        quoteSpanStart: 19,
        quoteSpanEnd: 27,
        verificationStatus: "verified",
        verifierVersion: "v-test",
        modelUsed: "gemini-test",
        explanation: "e",
      },
      {
        documentId: set.documents[0].id,
        analysisId: analysis.id,
        category: "penalty",
        quoteText: "late fee",
        verificationStatus: "not_found",
        verifierVersion: "v-test",
        modelUsed: "gemini-test",
        explanation: "e",
      },
    ]);
    await t.db.insert(schema.comparisonChanges).values({
      comparisonId: set.comparison.id,
      changeType: "changed",
      quoteTextA: "pay rent",
      docASpanStart: 19,
      docASpanEnd: 27,
      verificationStatusA: "verified",
      quoteTextB: "pay the rent",
      verificationStatusB: "approximate",
      verifierVersion: "v-test",
      explanation: "e",
    });
    const before = await snapshot(t);

    await claimGuestData(t.db, guest, user);

    const after = await snapshot(t);
    expect(after.findings).toEqual(before.findings);
    expect(after.comparisonChanges).toEqual(before.comparisonChanges);
    expect(after.findings).toHaveLength(2);
    expect(after.comparisonChanges).toHaveLength(1);
  });

  it("with no users row for the user it throws and claims nothing (the sign-in callback must create the user first)", async () => {
    const orphan: UserPrincipal = { type: "user", userId: "2c2c2c2c-0000-4000-8000-00000000000c" };
    const set = await insertGuestSet(t, guest, minutesFromNow(60));

    await expect(claimGuestData(t.db, guest, orphan)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("comparisons_owner_user_id_fkey") },
    });
    expect(await fates(t, set)).toEqual(allFates(set, "guest-owned"));
  });

  it("is one transaction: a failure on the last UPDATE (documents) rolls back the comparisons and drafts already re-owned", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));
    // Test-local trigger (this throwaway database only): fail the claim at its final statement.
    await t.client.exec(`
      CREATE FUNCTION test_fail_document_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure on documents'; END; $$;
      CREATE TRIGGER test_fail_document_claim BEFORE UPDATE OF owner_user_id ON documents
        FOR EACH ROW EXECUTE FUNCTION test_fail_document_claim();
    `);

    // drizzle wraps the database error; the injected one is its cause.
    await expect(claimGuestData(t.db, guest, user)).rejects.toMatchObject({
      cause: { message: "injected failure on documents" },
    });
    expect(await fates(t, set)).toEqual(allFates(set, "guest-owned"));

    // Positive control: with the trigger gone the same claim goes through.
    await t.client.exec("DROP TRIGGER test_fail_document_claim ON documents");
    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 2, comparisons: 1, drafts: 3 });
  });

  it("refuses a swapped or blank principal pair and changes nothing", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));
    const bad: [unknown, unknown][] = [
      [user, guest],
      [guest, guest],
      [user, user],
      [{ type: "guest", guestSessionId: " " }, user],
      [guest, { type: "user", userId: "" }],
      [undefined, user],
    ];
    for (const [g, u] of bad) {
      await expect(claimGuestData(t.db, g as GuestPrincipal, u as UserPrincipal)).rejects.toThrow(
        "claimGuestData needs a guest principal and a user principal",
      );
    }
    expect(await fates(t, set)).toEqual(allFates(set, "guest-owned"));
  });
});

describe("claimGuestData never strands a reference the sweep cannot clear", () => {
  it("the probes detect each shape they count (positive controls, one branch at a time)", async () => {
    const guestDocument = await insertDocument(t, guest, minutesFromNow(60));
    const userDocument = await insertDocument(t, user, null);
    const [guestParent] = await insertDraftChain(t, guest, minutesFromNow(60), null, 1);
    expect(await strandedReferences(t)).toBe(0);
    expect(await draftsGroundedOnGuestDocuments(t)).toBe(0);

    // A user comparison on a guest document.
    await insertComparison(t, user, userDocument.id, guestDocument.id, null);
    expect(await strandedReferences(t)).toBe(1);

    // A user revision whose parent is a guest draft.
    await t.db.insert(schema.drafts).values({
      ownerUserId: USER_ID,
      documentType: "leave_and_license",
      mode: "from_scratch",
      content: "user revision",
      revisionNumber: 2,
      parentDraftId: guestParent.id,
      modelUsed: "gemini-test",
    });
    expect(await strandedReferences(t)).toBe(2);

    // A user draft grounded on a guest document: counted by the grounding probe only.
    await insertDraftChain(t, user, null, guestDocument.id, 1);
    expect(await draftsGroundedOnGuestDocuments(t)).toBe(1);
    expect(await strandedReferences(t)).toBe(2);
  });

  it("a grounded draft that outlives its guest document is still claimed; the sweep then deletes the document and the draft lives on ungrounded (ruling: no grounding guard)", async () => {
    const expiredDocument = await insertDocument(t, guest, minutesFromNow(-1));
    // Malformed on purpose: the draft's expiry is not capped at its document's.
    const [draft] = await insertDraftChain(t, guest, minutesFromNow(60), expiredDocument.id, 1);

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 0, comparisons: 0, drafts: 1 });
    expect(await draftsGroundedOnGuestDocuments(t)).toBe(1);
    expect(await strandedReferences(t)).toBe(0);

    expect(await sweep(t)).toEqual([expiredDocument.storageRef]);
    const [survivor] = await t.db.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id));
    expect(survivor).toMatchObject({ ownerUserId: USER_ID, expiresAt: null, mode: "document_grounded", groundingDocumentId: null });
    expect(await t.db.select().from(schema.documents).where(eq(schema.documents.id, expiredDocument.id))).toEqual([]);
    expect(await draftsGroundedOnGuestDocuments(t)).toBe(0);
  });

  it("a comparison is not claimed while one of its documents has expired (malformed: the comparison outlives it)", async () => {
    const live = await insertDocument(t, guest, minutesFromNow(60));
    const expired = await insertDocument(t, guest, minutesFromNow(-1));
    const comparison = await insertComparison(t, guest, live.id, expired.id, minutesFromNow(60));

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 1, comparisons: 0, drafts: 0 });
    expect(await strandedReferences(t)).toBe(0);
    const [left] = await t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, comparison.id));
    expect(left.ownerGuestSessionId).toBe(guest.guestSessionId);
  });

  it("a comparison whose other document the user already owns is claimed with it", async () => {
    const mine = await insertDocument(t, user, null);
    const guests = await insertDocument(t, guest, minutesFromNow(60));
    await insertComparison(t, guest, mine.id, guests.id, minutesFromNow(60));

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 1, comparisons: 1, drafts: 0 });
    expect(await strandedReferences(t)).toBe(0);
  });

  it("a revision is not claimed while an ancestor has expired (malformed: a later revision outlives its root)", async () => {
    const chain = await insertDraftChain(t, guest, minutesFromNow(60), null);
    await t.db.update(schema.drafts).set({ expiresAt: minutesFromNow(-1) }).where(eq(schema.drafts.id, chain[0].id));

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
    expect(await strandedReferences(t)).toBe(0);
  });

  it("a from-scratch chain two branches wide is claimed whole, root first", async () => {
    const chain = await insertDraftChain(t, guest, minutesFromNow(60), null, 4);
    const [branch] = await t.db
      .insert(schema.drafts)
      .values({
        ownerGuestSessionId: guest.guestSessionId,
        documentType: "leave_and_license",
        mode: "from_scratch",
        content: "branch",
        revisionNumber: 2,
        parentDraftId: chain[0].id,
        modelUsed: "gemini-test",
        expiresAt: chain[0].expiresAt,
      })
      .returning();

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 0, comparisons: 0, drafts: 5 });
    const [claimedBranch] = await t.db.select().from(schema.drafts).where(eq(schema.drafts.id, branch.id));
    expect(claimedBranch.ownerUserId).toBe(USER_ID);
  });

  it("after a mixed claim and a sweep, nothing is left behind: claimed rows are the user's, expired ones are gone", async () => {
    const live = await insertGuestSet(t, guest, minutesFromNow(60));
    const expired = await insertGuestSet(t, guest, minutesFromNow(-1));

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 2, comparisons: 1, drafts: 3 });
    expect(await sweep(t)).toEqual(expired.documents.map((d) => d.storageRef).sort());

    expect(await fates(t, live)).toEqual(allFates(live, "claimed"));
    expect(await fates(t, expired)).toEqual(allFates(expired, "deleted"));
    expect(await strandedReferences(t)).toBe(0);
    expect(await draftsGroundedOnGuestDocuments(t)).toBe(0);
  });
});

describe("lock order and the deadlock retry", () => {
  const draft = (id: string, parentDraftId: string | null = null) => ({ id, parentDraftId });

  it("sweepOrderOfDrafts is the sweep's pass order: leaves first, each revision after all its descendants", () => {
    // r1 ← r2 ← r3, and a branch r1 ← b2. The sweep's passes: {r3, b2}, then r2, then r1.
    expect(sweepOrderOfDrafts([draft("r1"), draft("r2", "r1"), draft("r3", "r2"), draft("b2", "r1")])).toEqual([
      "b2",
      "r3",
      "r2",
      "r1",
    ]);
    // Two independent chains: every leaf before any parent.
    expect(sweepOrderOfDrafts([draft("a1"), draft("a2", "a1"), draft("c1"), draft("c2", "c1"), draft("c3", "c2")])).toEqual([
      "a2",
      "c3",
      "a1",
      "c2",
      "c1",
    ]);
    // A malformed cycle never becomes a leaf; it goes last instead of looping.
    expect(sweepOrderOfDrafts([draft("x", "y"), draft("y", "x"), draft("z", "x")])).toEqual(["z", "x", "y"]);
  });

  // A test-local trigger raises 40P01 ("deadlock detected") on the claim's documents UPDATE for the
  // first `failures` attempts. A sequence counts attempts because it is not rolled back with them.
  async function injectDeadlocks(failures: number) {
    await t.client.exec(`
      CREATE SEQUENCE test_claim_attempts;
      CREATE FUNCTION test_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('test_claim_attempts') <= ${failures} THEN
          RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER test_deadlock BEFORE UPDATE OF owner_user_id ON documents
        FOR EACH STATEMENT EXECUTE FUNCTION test_deadlock();
    `);
  }

  it("a claim aborted by one deadlock is retried once and completes", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));
    await injectDeadlocks(1);

    expect(await claimGuestData(t.db, guest, user)).toEqual({ documents: 2, comparisons: 1, drafts: 3 });
    expect(await fates(t, set)).toEqual(allFates(set, "claimed"));
  });

  it("a second deadlock is thrown, and the claim leaves nothing half-done", async () => {
    const set = await insertGuestSet(t, guest, minutesFromNow(60));
    await injectDeadlocks(2);

    await expect(claimGuestData(t.db, guest, user)).rejects.toMatchObject({ cause: { code: "40P01" } });
    expect(await fates(t, set)).toEqual(allFates(set, "guest-owned"));
  });
});
