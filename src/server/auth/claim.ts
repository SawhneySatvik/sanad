/**
 * Re-owns a guest's documents, comparisons and drafts to a signed-in user, in one transaction. Guest
 * threads are client-held and imported separately; not touched here. Storage refs are not touched
 * either — a claimed document keeps its `guest:<id>/...` ref forever; access follows the row's owner
 * via canAccess. The caller must ensure a `users` row exists for `user` first, or nothing is claimed.
 */

import { and, asc, eq, gt, inArray, isNull, or, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import type { Principal } from "../core/types";

/** The guest half of a claim: a Principal narrowed to its guest variant. */
export type GuestPrincipal = Extract<Principal, { type: "guest" }>;
/** The signed-in half of a claim: a Principal narrowed to its user variant. */
export type UserPrincipal = Extract<Principal, { type: "user" }>;

/** Counts of rows re-owned by claimGuestData, by table. */
export interface ClaimResult {
  documents: number;
  comparisons: number;
  drafts: number;
}

type GuestOwnedTable = typeof schema.documents | typeof schema.comparisons | typeof schema.drafts;

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Re-checked by every UPDATE inside the transaction: a row is either re-owned here (and the sweep's
// own re-check then skips it) or deleted by the sweep first (and this claim then finds nothing) —
// never both, since now() is fixed for the whole transaction.
function stillClaimable(table: GuestOwnedTable, guestSessionId: string) {
  return and(
    eq(table.ownerGuestSessionId, guestSessionId),
    or(isNull(table.expiresAt), gt(table.expiresAt, sql`now()`)),
  );
}

// True when the document will belong to the user once this claim commits: it already does, or it is
// this guest's and passes the same expiry re-check the documents UPDATE applies.
function documentComesAlong(documentId: AnyColumn, guestSessionId: string, userId: string) {
  return sql`EXISTS (
    SELECT 1 FROM ${schema.documents}
     WHERE ${schema.documents.id} = ${documentId}
       AND (${schema.documents.ownerUserId} = ${userId} OR ${stillClaimable(schema.documents, guestSessionId)})
  )`;
}

/**
 * The sweep's draft delete order: pass after pass it deletes the revisions no remaining revision
 * points at, so a revision goes in the pass after its last descendant. Returns ids leaf-first by
 * pass, id order within a pass. A malformed cycle never becomes a leaf; its members go last.
 */
export function sweepOrderOfDrafts(drafts: readonly { id: string; parentDraftId: string | null }[]): string[] {
  const remaining = new Map(drafts.map((d) => [d.id, d.parentDraftId]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const parents = new Set(remaining.values());
    const pass = [...remaining.keys()].filter((id) => !parents.has(id)).sort();
    if (pass.length === 0) break;
    for (const id of pass) remaining.delete(id);
    order.push(...pass);
  }
  return [...order, ...[...remaining.keys()].sort()];
}

function isDeadlock(error: unknown): boolean {
  const withCode = (value: unknown) => (value as { code?: unknown } | null)?.code === "40P01";
  return withCode(error) || withCode((error as { cause?: unknown } | null)?.cause);
}

async function claimOnce(db: Db, guestSessionId: string, userId: string): Promise<ClaimResult> {
  const reowned = { ownerUserId: userId, ownerGuestSessionId: null, expiresAt: null };

  return db.transaction(async (tx) => {
    // 1. Locks every claimable row, in the order the sweep deletes them — comparisons, then drafts
    // leaf-first, then documents — before any UPDATE. Matching the sweep's delete order avoids a
    // deadlock for every row except one that expires mid-claim, where the sweep's own scan/cascade
    // order can still lock in reverse; a deadlocked claim retries once (see claimGuestData).
    const comparisonIds = (
      await tx
        .select({ id: schema.comparisons.id })
        .from(schema.comparisons)
        .where(stillClaimable(schema.comparisons, guestSessionId))
        .orderBy(asc(schema.comparisons.id))
        .for("update")
    ).map((row) => row.id);

    // The pass order is computed over the guest's whole draft forest, as the sweep sees it; each
    // revision is then locked on its own, so the lock order is exactly that order.
    const guestDrafts = await tx
      .select({ id: schema.drafts.id, parentDraftId: schema.drafts.parentDraftId })
      .from(schema.drafts)
      .where(eq(schema.drafts.ownerGuestSessionId, guestSessionId));
    const draftIds: string[] = [];
    for (const id of sweepOrderOfDrafts(guestDrafts)) {
      const [locked] = await tx
        .select({ id: schema.drafts.id })
        .from(schema.drafts)
        .where(and(eq(schema.drafts.id, id), stillClaimable(schema.drafts, guestSessionId)))
        .for("update");
      if (locked) draftIds.push(locked.id);
    }

    const documentIds = (
      await tx
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(stillClaimable(schema.documents, guestSessionId))
        .orderBy(asc(schema.documents.id))
        .for("update")
    ).map((row) => row.id);

    // 2. Re-own the locked rows. A row inserted after its table was locked is not taken: it stays the
    // guest's and expires on its own.
    //
    // A comparison moves only if both its documents move too. LEAST() at creation already makes that
    // true; this guard keeps a malformed row (a comparison outliving a document) from leaving a user's
    // comparison pinning an expired guest document the sweep can then never delete (RESTRICT).
    const comparisons =
      comparisonIds.length === 0
        ? []
        : await tx
            .update(schema.comparisons)
            .set(reowned)
            .where(
              and(
                inArray(schema.comparisons.id, comparisonIds),
                stillClaimable(schema.comparisons, guestSessionId),
                documentComesAlong(schema.comparisons.documentAId, guestSessionId, userId),
                documentComesAlong(schema.comparisons.documentBId, guestSessionId, userId),
              ),
            )
            .returning({ id: schema.comparisons.id });

    // Root first, then each next revision once its parent is the user's, so a revision never moves
    // without every ancestor (parent_draft_id is RESTRICT: a user's revision would otherwise pin an
    // expired guest parent forever). Every row here is already locked, so these passes wait on nothing.
    let drafts = 0;
    while (draftIds.length > 0) {
      const moved = await tx
        .update(schema.drafts)
        .set(reowned)
        .where(
          and(
            inArray(schema.drafts.id, draftIds),
            stillClaimable(schema.drafts, guestSessionId),
            or(
              isNull(schema.drafts.parentDraftId),
              sql`EXISTS (SELECT 1 FROM drafts parent WHERE parent.id = ${schema.drafts.parentDraftId} AND parent.owner_user_id = ${userId})`,
            ),
          ),
        )
        .returning({ id: schema.drafts.id });
      if (moved.length === 0) break;
      drafts += moved.length;
    }

    const documents =
      documentIds.length === 0
        ? []
        : await tx
            .update(schema.documents)
            .set(reowned)
            .where(and(inArray(schema.documents.id, documentIds), stillClaimable(schema.documents, guestSessionId)))
            .returning({ id: schema.documents.id });

    return { documents: documents.length, comparisons: comparisons.length, drafts };
  });
}

/**
 * Re-owns every claimable document, comparison, and draft from `guest` to `user`, in one
 * transaction; retries once on a deadlock with a concurrent sweep.
 * @throws Error if `guest` or `user` is not the expected principal type, or either id is blank.
 */
export async function claimGuestData(db: Db, guest: GuestPrincipal, user: UserPrincipal): Promise<ClaimResult> {
  // Fail closed on a swapped or blank principal: this re-owns data, so it must never guess.
  if (guest?.type !== "guest" || !isNonBlank(guest.guestSessionId) || user?.type !== "user" || !isNonBlank(user.userId)) {
    throw new Error("claimGuestData needs a guest principal and a user principal");
  }
  try {
    return await claimOnce(db, guest.guestSessionId, user.userId);
  } catch (error) {
    // One retry, for the rare deadlock a matched-but-imperfect lock order can still hit (see
    // claimOnce). A second one is thrown.
    if (!isDeadlock(error)) throw error;
    return claimOnce(db, guest.guestSessionId, user.userId);
  }
}
