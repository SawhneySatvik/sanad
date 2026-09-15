// Shared fixtures for the claim tests. Rows are inserted straight through the schema with the
// expiries the real repositories produce: a comparison capped at LEAST(document expiries), a draft
// chain inheriting its root's expiry — so a guest's whole set ties on one expires_at.

import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { MIGRATIONS_DIR } from "@/db/migrate";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { buildRef } from "@/server/storage/refs";
import type { GuestPrincipal, UserPrincipal } from "@/server/auth/claim";

// The claiming principals and a second, unrelated user/guest pair used as "someone else" in
// cross-principal assertions.
export const USER_ID = "2a2a2a2a-0000-4000-8000-00000000000a";
export const OTHER_USER_ID = "2b2b2b2b-0000-4000-8000-00000000000b";
export const user: UserPrincipal = { type: "user", userId: USER_ID };
export const otherUser: UserPrincipal = { type: "user", userId: OTHER_USER_ID };
export const guest: GuestPrincipal = { type: "guest", guestSessionId: "claiming-guest" };
export const otherGuest: GuestPrincipal = { type: "guest", guestSessionId: "other-guest" };

// The real M4 part-1 sweep (prod-only; never applied by createTestDb). Its REVOKEs name the Supabase
// API roles, so stand-ins are created first, as tests/unit/db/prod-only.test.ts does.
const M4_SWEEP = readFileSync(path.join(MIGRATIONS_DIR, "prod-only", "0002_m4_ttl_and_cleanup_functions.sql"), "utf8");

/** A TestDb with `user`/`otherUser` rows already present and the prod-only sweep applied. */
export async function createClaimTestDb(): Promise<TestDb> {
  const t = await createTestDb();
  await t.db.insert(schema.users).values([
    { id: USER_ID, email: "claimer@example.com" },
    { id: OTHER_USER_ID, email: "other@example.com" },
  ]);
  await t.client.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;");
  await t.client.exec(M4_SWEEP);
  return t;
}

// Runs the real sweep in its own transaction; returns the storage refs it would purge.
export async function sweep(t: TestDb): Promise<string[]> {
  const result = await t.client.query<{ refs: string[] }>("SELECT app_private.delete_expired_guest_rows() AS refs");
  return result.rows[0].refs;
}

/** An `expiresAt` value for fixtures that need a not-yet-expired row. */
export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function owner(principal: Principal) {
  return principal.type === "user"
    ? { ownerUserId: principal.userId, ownerGuestSessionId: null }
    : { ownerUserId: null, ownerGuestSessionId: principal.guestSessionId };
}

/** Inserts a single ready, owned document row directly through the schema, bypassing the repository. */
export async function insertDocument(t: TestDb, principal: Principal, expiresAt: Date | null) {
  const [row] = await t.db
    .insert(schema.documents)
    .values({
      ...owner(principal),
      storageRef: buildRef(principal, "lease.txt"),
      filename: "lease.txt",
      mimeType: "text/plain",
      inputMode: "text",
      processingStatus: "ready",
      canonicalText: "The Licensee shall pay rent on the 5th of every month.",
      canonicalTextHash: "hash",
      extractorVersion: "x@1",
      documentType: "leave_and_license",
      expiresAt,
    })
    .returning();
  return row;
}

/** Inserts a comparison row over the two given documents, directly through the schema. */
export async function insertComparison(
  t: TestDb,
  principal: Principal,
  documentAId: string,
  documentBId: string,
  expiresAt: Date | null,
) {
  const [row] = await t.db
    .insert(schema.comparisons)
    .values({ ...owner(principal), documentAId, documentBId, modelUsed: "gemini-test", expiresAt })
    .returning();
  return row;
}

// A root and `revisions - 1` children, each the parent of the next, all on the same expires_at.
export async function insertDraftChain(
  t: TestDb,
  principal: Principal,
  expiresAt: Date | null,
  groundingDocumentId: string | null,
  revisions = 3,
) {
  const chain: (typeof schema.drafts.$inferSelect)[] = [];
  for (let revision = 1; revision <= revisions; revision++) {
    const [row] = await t.db
      .insert(schema.drafts)
      .values({
        ...owner(principal),
        documentType: "leave_and_license",
        mode: groundingDocumentId ? "document_grounded" : "from_scratch",
        groundingDocumentId,
        content: `revision ${revision}`,
        revisionNumber: revision,
        parentDraftId: chain.at(-1)?.id ?? null,
        modelUsed: "gemini-test",
        expiresAt,
      })
      .returning();
    chain.push(row);
  }
  return chain;
}

// One guest session's worth of data: two documents, a comparison of them, and a draft chain grounded
// on the first — every row on the same expires_at, as the LEAST()/inheritance rules produce.
export async function insertGuestSet(t: TestDb, principal: Principal, expiresAt: Date) {
  const documentA = await insertDocument(t, principal, expiresAt);
  const documentB = await insertDocument(t, principal, expiresAt);
  const comparison = await insertComparison(t, principal, documentA.id, documentB.id, expiresAt);
  const drafts = await insertDraftChain(t, principal, expiresAt, documentA.id);
  return { documents: [documentA, documentB], comparison, drafts };
}

/** The row set `insertGuestSet` returns: two documents, their comparison, and a draft chain. */
export type GuestSet = Awaited<ReturnType<typeof insertGuestSet>>;

type RowFate = "deleted" | "claimed" | "guest-owned" | "user-owned-with-expiry";

async function fateOf(t: TestDb, table: typeof schema.documents | typeof schema.comparisons | typeof schema.drafts, id: string, userId: string): Promise<RowFate> {
  const [row] = await t.db
    .select({ ownerUserId: table.ownerUserId, ownerGuestSessionId: table.ownerGuestSessionId, expiresAt: table.expiresAt })
    .from(table)
    .where(eq(table.id, id));
  if (!row) return "deleted";
  if (row.ownerGuestSessionId !== null) return "guest-owned";
  if (row.ownerUserId === userId && row.expiresAt === null) return "claimed";
  return "user-owned-with-expiry";
}

// What happened to every row of a guest set, table by table.
export async function fates(t: TestDb, set: GuestSet, userId = USER_ID) {
  return {
    documents: await Promise.all(set.documents.map((row) => fateOf(t, schema.documents, row.id, userId))),
    comparison: await fateOf(t, schema.comparisons, set.comparison.id, userId),
    drafts: await Promise.all(set.drafts.map((row) => fateOf(t, schema.drafts, row.id, userId))),
  };
}

/** The expected `fates()` shape when every row in `set` landed the same way. */
export function allFates(set: GuestSet, fate: RowFate) {
  return { documents: set.documents.map(() => fate), comparison: fate, drafts: set.drafts.map(() => fate) };
}

// References the sweep can never clear: a user-owned comparison on a guest-owned document
// (comparisons → documents is RESTRICT: the sweep skips that document for good), or a user-owned
// revision whose parent is still guest-owned (parent_draft_id is RESTRICT: that parent is never a leaf).
export async function strandedReferences(t: TestDb): Promise<number> {
  const result = await t.client.query<{ n: number }>(`
    SELECT (
      (SELECT count(*) FROM comparisons c JOIN documents d ON d.id IN (c.document_a_id, c.document_b_id)
        WHERE c.owner_user_id IS NOT NULL AND d.owner_guest_session_id IS NOT NULL)
    + (SELECT count(*) FROM drafts r JOIN drafts p ON p.id = r.parent_draft_id
        WHERE r.owner_user_id IS NOT NULL AND p.owner_guest_session_id IS NOT NULL)
    )::int AS n`);
  return result.rows[0].n;
}

// User-owned drafts grounded on a still-guest-owned document. NOT stranded (grounding_document_id
// is ON DELETE SET NULL), and well-formed data never produces one — a grounded draft's expiry is
// capped at its document's, so the consistency tests expect 0.
export async function draftsGroundedOnGuestDocuments(t: TestDb): Promise<number> {
  const result = await t.client.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM drafts r JOIN documents d ON d.id = r.grounding_document_id
     WHERE r.owner_user_id IS NOT NULL AND d.owner_guest_session_id IS NOT NULL`);
  return result.rows[0].n;
}
