/**
 * Comparisons repository — the only module that writes `comparison_changes`. A comparison associates
 * two documents, so every function that names both documents loads both and passes both to
 * assertCanAccessAll; getComparison authorizes through the comparison row itself. Each side of a
 * change is written only with the VerifyResult verify() issued for that side's quote against that
 * side's document — a side-A result offered for side B throws; what's stored is an audit record.
 */

import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { newId } from "../../db/ids";
import * as schema from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import { guestDataTtlSeconds } from "../core/guest-ttl";
import type { InputMode, Principal } from "../core/types";
import { assertVerifyResultFor, type VerifyResult } from "../deterministic/verify";
import { assertCanAccess, assertCanAccessAll } from "./access";
import { assertBelowActiveRowCap, isUuidShaped, type Document } from "./documents";

/** A persisted comparison row, as read from the database. */
export type Comparison = typeof schema.comparisons.$inferSelect;
/** A persisted comparison-change row, as read from the database. */
export type ComparisonChange = typeof schema.comparisonChanges.$inferSelect;
/** Whether a comparison change is an addition, removal, or a changed clause. */
export type ComparisonChangeType = ComparisonChange["changeType"];

/** An extracted document, narrowed to the fields a comparison needs. */
export type ReadyDocument = Document & { canonicalText: string; canonicalTextHash: string; inputMode: InputMode };

/** One changed, added, or removed clause to persist as part of a comparison. */
export interface ComparisonChangeWrite {
  changeType: ComparisonChangeType;
  explanation: string;
  // An added clause has no A side and a removed clause no B side: that side's quote is always null.
  // A side that has a clause may still carry no quote (compare.ts found none it could place inside
  // the clause), and then it has no status either.
  quoteA: string | null;
  quoteB: string | null;
  // verify()'s result for exactly that side's quote against that side's document — set exactly
  // when the quote is.
  verificationA: VerifyResult | null;
  verificationB: VerifyResult | null;
}

/** Fields required to persist a comparison and its changes. */
export interface CreateComparisonInput {
  documentAId: string;
  documentBId: string;
  // The model that explained the changes — a fallback-model comparison must not look like a
  // primary-model one after a reload — or "none" when no model was called.
  modelUsed: string;
  changes: readonly ComparisonChangeWrite[];
}

/** A comparison with its changes, in the order they were written. */
export interface ComparisonWithChanges {
  comparison: Comparison;
  changes: ComparisonChange[];
}

// Only the columns a write needs — not canonical_text (up to 500k chars per side).
const lockColumns = {
  id: schema.documents.id,
  ownerUserId: schema.documents.ownerUserId,
  ownerGuestSessionId: schema.documents.ownerGuestSessionId,
  processingStatus: schema.documents.processingStatus,
  inputMode: schema.documents.inputMode,
  canonicalTextHash: schema.documents.canonicalTextHash,
  expiresAt: schema.documents.expiresAt,
};

// One lookup per id, so a missing document stays `undefined` for assertCanAccessAll rather than
// silently shrinking an IN (...) result to one row that passes.
async function selectDocument(db: Db, documentId: string): Promise<Document | undefined> {
  if (!isUuidShaped(documentId)) return undefined;
  const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  return row;
}

// FOR SHARE: a concurrent guest-to-user claim re-owning the document waits for this transaction, so
// the comparison is never written against an owner the document no longer has.
async function lockDocument(db: Db, documentId: string) {
  if (!isUuidShaped(documentId)) return undefined;
  const [row] = await db.select(lockColumns).from(schema.documents).where(eq(schema.documents.id, documentId)).for("share");
  return row;
}

// Called only after assertCanAccessAll, so a foreign pending document is NOT_FOUND, never this.
function ready<
  T extends { processingStatus: string; canonicalText?: string | null; canonicalTextHash: string | null; inputMode: InputMode | null; expiresAt: Date | null },
>(document: T): T & { canonicalTextHash: string; inputMode: InputMode } {
  if (document.expiresAt !== null && document.expiresAt.getTime() <= Date.now()) throw notFound();
  if (
    document.processingStatus !== "ready" ||
    document.canonicalText === null ||
    document.canonicalTextHash === null ||
    document.inputMode === null
  ) {
    throw new AppError("INVALID_DOCUMENT", "The document has not been extracted.", { reason: "document_not_ready" });
  }
  return document as T & { canonicalTextHash: string; inputMode: InputMode };
}

/** Both documents, with their canonical text, for a comparison about to be computed. */
export async function getComparableDocuments(
  db: Db,
  principal: Principal,
  documentAId: string,
  documentBId: string,
): Promise<{ documentA: ReadyDocument; documentB: ReadyDocument }> {
  const documentA = await selectDocument(db, documentAId);
  const documentB = await selectDocument(db, documentBId);
  assertCanAccessAll(principal, [documentA, documentB]);
  // ready() has checked canonicalText too.
  return { documentA: ready(documentA!) as ReadyDocument, documentB: ready(documentB!) as ReadyDocument };
}

// A guest's comparison expires no later than either document it references — otherwise the TTL
// sweep would hit the documents' RESTRICT — and never later than a guest document's own TTL from
// now. A user's comparison expires only if a document it references does.
function comparisonExpiry(
  principal: Principal,
  documentA: { expiresAt: Date | null },
  documentB: { expiresAt: Date | null },
): Date | null {
  const bounds = [documentA.expiresAt, documentB.expiresAt];
  if (principal.type === "guest") bounds.push(new Date(Date.now() + guestDataTtlSeconds() * 1000));
  const times = bounds.filter((bound): bound is Date => bound !== null).map((bound) => bound.getTime());
  return times.length === 0 ? null : new Date(Math.min(...times));
}

function sideValues(
  quote: string | null,
  result: VerifyResult | null,
  document: { canonicalTextHash: string; inputMode: InputMode },
) {
  if (quote === null) {
    if (result !== null) throw new Error("A comparison side without a quote cannot carry a verification result");
    return { quote: null, spanStart: null, spanEnd: null, status: null, verifierVersion: null };
  }
  assertVerifyResultFor(result, { quote, canonicalTextHash: document.canonicalTextHash, inputMode: document.inputMode });
  return {
    quote,
    spanStart: result.spanStart,
    spanEnd: result.spanEnd,
    status: result.status,
    verifierVersion: result.verifierVersion,
  };
}

// Which sides a change of each type has a clause on.
const SIDES_BY_TYPE: Record<ComparisonChangeType, { a: boolean; b: boolean }> = {
  added: { a: false, b: true },
  removed: { a: true, b: false },
  changed: { a: true, b: true },
};

function changeValues(
  comparisonId: string,
  change: ComparisonChangeWrite,
  documentA: { canonicalTextHash: string; inputMode: InputMode },
  documentB: { canonicalTextHash: string; inputMode: InputMode },
): typeof schema.comparisonChanges.$inferInsert {
  const sides = SIDES_BY_TYPE[change.changeType];
  if ((change.quoteA !== null && !sides.a) || (change.quoteB !== null && !sides.b)) {
    throw new Error(`A "${change.changeType}" comparison change has a quote on a side it has no clause on`);
  }
  const a = sideValues(change.quoteA, change.verificationA, documentA);
  const b = sideValues(change.quoteB, change.verificationB, documentB);
  if (a.verifierVersion !== null && b.verifierVersion !== null && a.verifierVersion !== b.verifierVersion) {
    throw new Error("Both sides of a change must be verified by the same verifier version");
  }
  return {
    id: newId(),
    comparisonId,
    changeType: change.changeType,
    explanation: change.explanation,
    quoteTextA: a.quote,
    docASpanStart: a.spanStart,
    docASpanEnd: a.spanEnd,
    verificationStatusA: a.status,
    quoteTextB: b.quote,
    docBSpanStart: b.spanStart,
    docBSpanEnd: b.spanEnd,
    verificationStatusB: b.status,
    verifierVersion: a.verifierVersion ?? b.verifierVersion,
  };
}

/**
 * Writes the comparison and its changes in one short transaction, all or nothing. Call only after
 * the LLM round-trip: re-checks both documents inside the transaction. Over the principal's
 * active-comparison cap it is RATE_LIMITED (see assertBelowActiveRowCap).
 */
export async function createComparison(
  db: Db,
  principal: Principal,
  input: CreateComparisonInput,
): Promise<ComparisonWithChanges> {
  return db.transaction(async (tx) => {
    const lockedA = await lockDocument(tx, input.documentAId);
    const lockedB = await lockDocument(tx, input.documentBId);
    assertCanAccessAll(principal, [lockedA, lockedB]);
    const documentA = ready(lockedA!);
    const documentB = ready(lockedB!);
    await assertBelowActiveRowCap(tx, principal, "comparisons");

    // Ids are generated here (UUIDv7, time-ordered) so the changes read back in the order written.
    // Every change is checked before anything is inserted.
    const comparisonId = newId();
    const values = input.changes.map((change) => changeValues(comparisonId, change, documentA, documentB));

    const [comparison] = await tx
      .insert(schema.comparisons)
      .values({
        id: comparisonId,
        ownerUserId: principal.type === "user" ? principal.userId : null,
        ownerGuestSessionId: principal.type === "guest" ? principal.guestSessionId : null,
        documentAId: documentA.id,
        documentBId: documentB.id,
        modelUsed: input.modelUsed,
        expiresAt: comparisonExpiry(principal, documentA, documentB),
      })
      .returning();
    // Written after the comparison row: the native-document ceiling trigger reaches each side's
    // document through it.
    const rows = values.length === 0 ? [] : await tx.insert(schema.comparisonChanges).values(values).returning();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return { comparison, changes: values.map((value) => byId.get(value.id!)!) };
  });
}

/** A comparison and its changes, in the order they were written. */
export async function getComparison(db: Db, principal: Principal, comparisonId: string): Promise<ComparisonWithChanges> {
  const [comparison] = isUuidShaped(comparisonId)
    ? await db.select().from(schema.comparisons).where(and(
        eq(schema.comparisons.id, comparisonId),
        or(isNull(schema.comparisons.expiresAt), gt(schema.comparisons.expiresAt, sql`now()`)),
      ))
    : [];
  assertCanAccess(principal, comparison);
  const [documentA, documentB] = await Promise.all([
    selectDocument(db, comparison.documentAId),
    selectDocument(db, comparison.documentBId),
  ]);
  assertCanAccessAll(principal, [documentA, documentB]);
  if ([documentA, documentB].some((document) => document!.expiresAt !== null && document!.expiresAt!.getTime() <= Date.now())) {
    throw notFound();
  }
  if (comparison.projectId) {
    const [project] = await db.select({ ownerUserId: schema.projects.ownerUserId }).from(schema.projects)
      .where(eq(schema.projects.id, comparison.projectId));
    assertCanAccess(principal, project && { ownerUserId: project.ownerUserId, ownerGuestSessionId: null });
  }
  const changes = await db
    .select()
    .from(schema.comparisonChanges)
    .where(eq(schema.comparisonChanges.comparisonId, comparison.id))
    .orderBy(asc(schema.comparisonChanges.id));
  return { comparison, changes };
}
