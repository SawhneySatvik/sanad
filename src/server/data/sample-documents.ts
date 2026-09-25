/**
 * Sample-linked documents: the two data-layer operations the samples-open flow needs beyond what
 * documents.ts already exposes — finding a principal's existing copy of a given sample, and
 * inserting a fresh one. Every function here takes a principal and goes through the same
 * canAccess chokepoint every other repository function uses.
 */

import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { guestDataTtlSeconds } from "../core/guest-ttl";
import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { refBelongsTo } from "../storage/refs";
import { assertCanAccess, canAccess } from "./access";
import { assertBelowActiveRowCap } from "./documents";

function ownerFilter(principal: Principal) {
  return principal.type === "user"
    ? eq(schema.documents.ownerUserId, principal.userId)
    : eq(schema.documents.ownerGuestSessionId, principal.guestSessionId);
}

/**
 * The principal's own unexpired copy of `sampleId`, if any. Ordered newest-activity first with a
 * deterministic id tiebreak — never "whichever row the planner happens to return first" — though in
 * practice a principal holds at most one live copy of any given sample.
 */
export async function findOwnedSampleDocument(db: Db, principal: Principal, sampleId: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({
      id: schema.documents.id,
      ownerUserId: schema.documents.ownerUserId,
      ownerGuestSessionId: schema.documents.ownerGuestSessionId,
    })
    .from(schema.documents)
    .where(
      and(
        ownerFilter(principal),
        eq(schema.documents.sampleId, sampleId),
        or(isNull(schema.documents.expiresAt), gt(schema.documents.expiresAt, sql`now()`)),
      ),
    )
    .orderBy(desc(schema.documents.updatedAt), desc(schema.documents.id))
    .limit(1);
  const [row] = rows;
  // The WHERE clause already narrows to this principal's own rows; canAccess stays the authority
  // on what's returned, the same belt-and-suspenders pattern documents.ts's listDocuments() uses.
  return row && canAccess(principal, row) ? { id: row.id } : null;
}

/** Fields required to record a document row for a freshly (or already) written sample copy. */
export interface NewSampleDocumentInput {
  sampleId: string;
  storageRef: string;
  filename: string;
  mimeType: string;
}

/** Whether findOrInsertSampleDocument found the principal's existing copy or inserted a fresh one. */
export interface SampleDocumentReservation {
  id: string;
  created: boolean;
}

/**
 * One row per (principal, sample): finds the principal's existing copy, or inserts a fresh one
 * bound to `input.storageRef` — the caller must already have written bytes there before calling
 * this, never inside this transaction: a failed or lost-race reservation still needs a live ref to
 * clean the orphaned object up against afterward. Runs its own short transaction, holding the exact
 * row-cap advisory lock the create path (assertBelowActiveRowCap) already uses — but only applies
 * that check's verdict if there is no existing copy to return: a principal already at their cap,
 * re-opening a sample they already hold, gets that copy back, never a spurious rate-limit for a row
 * they already own. The lock's own query still runs first every time, so the serialization that
 * prevents two concurrent opens from inserting two rows holds regardless of which branch is taken.
 */
export async function findOrInsertSampleDocument(
  db: Db,
  principal: Principal,
  input: NewSampleDocumentInput,
): Promise<SampleDocumentReservation> {
  return db.transaction(async (tx) => {
    let overCap: AppError | null = null;
    try {
      await assertBelowActiveRowCap(tx, principal, "documents");
    } catch (error) {
      // Only RATE_LIMITED is ever deferred — anything else (a genuine failure) still fails fast.
      if (error instanceof AppError && error.code === "RATE_LIMITED") overCap = error;
      else throw error;
    }

    const existing = await findOwnedSampleDocument(tx, principal, input.sampleId);
    if (existing) return { id: existing.id, created: false };
    if (overCap) throw overCap;

    if (!refBelongsTo(input.storageRef, principal)) throw notFound();
    const owner =
      principal.type === "user"
        ? { ownerUserId: principal.userId, ownerGuestSessionId: null, expiresAt: null }
        : {
            ownerUserId: null,
            ownerGuestSessionId: principal.guestSessionId,
            expiresAt: new Date(Date.now() + guestDataTtlSeconds() * 1000),
          };
    const [row] = await tx
      .insert(schema.documents)
      .values({ ...owner, storageRef: input.storageRef, filename: input.filename, mimeType: input.mimeType, sampleId: input.sampleId })
      .returning();
    assertCanAccess(principal, row);
    return { id: row.id, created: true };
  });
}
