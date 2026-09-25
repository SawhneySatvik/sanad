/**
 * Documents repository. Every function authorizes through canAccess before it reads or changes a row.
 * analyses.ts, findings.ts, and finding-lens-explanations.ts authorize child rows through getDocumentSummary.
 */

import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { optionalEnv } from "../core/env";
import { guestDataTtlSeconds } from "../core/guest-ttl";
import { AppError, notFound } from "../core/errors";
import type { InputMode, Principal } from "../core/types";
import type { DocumentTypeId } from "../deterministic/document-type-registry";
import { refBelongsTo } from "../storage/refs";
import { assertCanAccess, canAccess } from "./access";

/** A persisted document row, as read from the database. */
export type Document = typeof schema.documents.$inferSelect;
/** A document row without its (up to 500k char) canonical_text — for lists and ownership checks. */
export type DocumentSummary = Omit<Document, "canonicalText">;

/**
 * Guest uploads expire (2-4 h); 3 h matches the guest session cookie's own lifetime
 * (auth/session.ts's GUEST_SESSION_TTL_SECONDS), so a document never outlives the session that owns
 * it by more than the time between session start and upload.
 */
export const DOCUMENT_GUEST_TTL_SECONDS = 3 * 60 * 60;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A malformed id never reaches Postgres: "invalid input syntax for type uuid" would be a 500, which is distinguishable from the 404 a foreign id gets. */
export function isUuidShaped(value: string): boolean {
  return UUID_RE.test(value);
}

// Everything except canonical_text (up to 500k chars), for lists and ownership checks.
const summaryColumns = {
  id: schema.documents.id,
  ownerUserId: schema.documents.ownerUserId,
  ownerGuestSessionId: schema.documents.ownerGuestSessionId,
  projectId: schema.documents.projectId,
  storageRef: schema.documents.storageRef,
  filename: schema.documents.filename,
  mimeType: schema.documents.mimeType,
  inputMode: schema.documents.inputMode,
  processingStatus: schema.documents.processingStatus,
  canonicalTextHash: schema.documents.canonicalTextHash,
  extractorVersion: schema.documents.extractorVersion,
  documentType: schema.documents.documentType,
  jurisdiction: schema.documents.jurisdiction,
  detectionConfidence: schema.documents.detectionConfidence,
  uploadedAt: schema.documents.uploadedAt,
  expiresAt: schema.documents.expiresAt,
  title: schema.documents.title,
  sampleId: schema.documents.sampleId,
  updatedAt: schema.documents.updatedAt,
};

function firstOrNotFound<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (!row) throw notFound();
  return row;
}

// storage/refs throws VALIDATION_FAILED on a malformed ref or an id unsafe for a ref segment; here
// either is simply "not this principal's ref".
function refBelongsToPrincipal(storageRef: string, principal: Principal): boolean {
  try {
    return refBelongsTo(storageRef, principal);
  } catch {
    return false;
  }
}

/**
 * Default caps on the active (unexpired) rows one principal holds in each of documents, comparisons
 * and drafts — every row, revisions included, since each costs storage. A guest session lives 3 h
 * and the free tier allows about 20 model calls a day, so 30 leaves room for failed uploads and
 * model-free comparisons. A user's rows never expire and there is no delete route yet, so the user
 * cap is a lifetime quota for now.
 */
export const DEFAULT_MAX_ACTIVE_ROWS = { guest: 30, user: 500 } as const;
const MAX_ACTIVE_ROWS_ENV_VAR = { guest: "MAX_ACTIVE_ROWS_PER_GUEST", user: "MAX_ACTIVE_ROWS_PER_USER" } as const;
// An override past this is clamped: a typo must not disable the cap.
const MAX_ACTIVE_ROWS_OVERRIDE = 100_000;

// A plain positive decimal integer, else the default: a misconfigured cap must never take the app down.
function maxActiveRows(principal: Principal): number {
  const raw = optionalEnv(MAX_ACTIVE_ROWS_ENV_VAR[principal.type])?.trim();
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return DEFAULT_MAX_ACTIVE_ROWS[principal.type];
  return Math.min(Number(raw), MAX_ACTIVE_ROWS_OVERRIDE);
}

const CAPPED_TABLES = { documents: schema.documents, comparisons: schema.comparisons, drafts: schema.drafts };

/** A table whose rows count against a principal's active-row cap. */
export type CappedTable = keyof typeof CAPPED_TABLES;

/**
 * Throws RATE_LIMITED when `principal` already holds its cap of active rows in `tableName`; for a guest,
 * retry-after is when its oldest active row expires. Inside the create transaction, it first takes a
 * transaction-scoped advisory lock on (table, principal), held until commit, so concurrent creates
 * for one principal count and insert one at a time and cannot overshoot. Outside a transaction it
 * is a pre-check before work a rejection would waste, such as a model call.
 */
export async function assertBelowActiveRowCap(db: Db, principal: Principal, tableName: CappedTable): Promise<void> {
  const table = CAPPED_TABLES[tableName];
  const [ownerColumn, ownerId] =
    principal.type === "user" ? [table.ownerUserId, principal.userId] : [table.ownerGuestSessionId, principal.guestSessionId];
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tableName}:${principal.type}:${ownerId}`}, 0))`);
  const [{ active, oldestExpiry }] = await db
    .select({ active: sql<number>`count(*)::int`, oldestExpiry: sql<Date | null>`min(${table.expiresAt})`.mapWith(table.expiresAt) })
    .from(table)
    .where(and(eq(ownerColumn, ownerId), or(isNull(table.expiresAt), gt(table.expiresAt, sql`now()`))));
  const cap = maxActiveRows(principal);
  if (active < cap) return;
  const retryAfterSeconds = oldestExpiry === null ? undefined : Math.max(1, Math.ceil((oldestExpiry.getTime() - Date.now()) / 1000));
  throw new AppError("RATE_LIMITED", `The ${principal.type} already has ${active} active ${tableName}, the cap of ${cap}.`, {
    retryAfterSeconds,
  });
}

/** Fields required to record a newly confirmed upload as a pending document. */
export interface NewDocumentInput {
  storageRef: string;
  filename: string;
  mimeType: string;
}

/**
 * The service calls storage.confirmUpload first; the owner-prefix check is repeated here so no
 * caller can mint a row over another principal's object. A ref that already backs a document
 * (UNIQUE storage_ref, and lower(storage_ref)) is NOT_FOUND, like a second confirmUpload. Over the
 * principal's active-document cap it is RATE_LIMITED (see assertBelowActiveRowCap).
 */
export async function createPendingDocument(db: Db, principal: Principal, input: NewDocumentInput): Promise<Document> {
  if (!refBelongsToPrincipal(input.storageRef, principal)) throw notFound();
  const owner =
    principal.type === "user"
      ? { ownerUserId: principal.userId, ownerGuestSessionId: null, expiresAt: null }
      : {
          ownerUserId: null,
          ownerGuestSessionId: principal.guestSessionId,
          expiresAt: new Date(Date.now() + guestDataTtlSeconds() * 1000),
        };
  return db.transaction(async (tx) => {
    await assertBelowActiveRowCap(tx, principal, "documents");
    const [reserved] = await tx.select({ storageRef: schema.storageCleanupOutbox.storageRef })
      .from(schema.storageCleanupOutbox)
      .where(sql`lower(${schema.storageCleanupOutbox.storageRef}) = lower(${input.storageRef})`)
      .limit(1);
    if (reserved) throw notFound();
    try {
      const rows = await tx
        .insert(schema.documents)
        .values({ ...owner, storageRef: input.storageRef, filename: input.filename, mimeType: input.mimeType })
        .onConflictDoNothing()
        .returning();
      return firstOrNotFound(rows);
    } catch (error) {
      const databaseError = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      const code = databaseError.code ?? databaseError.cause?.code;
      const constraint = databaseError.constraint ?? databaseError.cause?.constraint;
      if (code === "23514" && constraint === "documents_storage_ref_tombstone_guard") throw notFound();
      throw error;
    }
  });
}

/**
 * Fetches a document, including its canonical_text, by id. Ownership is checked on the summary
 * first, so a foreign id never loads another principal's text and answers in the same time as a
 * missing one, whatever that text's size.
 */
export async function getDocument(db: Db, principal: Principal, documentId: string): Promise<Document> {
  await getDocumentSummary(db, principal, documentId);
  const [row] = await db.select().from(schema.documents).where(and(
    eq(schema.documents.id, documentId),
    or(isNull(schema.documents.expiresAt), gt(schema.documents.expiresAt, sql`now()`)),
  ));
  // Checked again on the row actually returned: it may have been deleted or re-owned in between.
  assertCanAccess(principal, row);
  if (row.projectId) {
    const [project] = await db.select({ ownerUserId: schema.projects.ownerUserId }).from(schema.projects)
      .where(eq(schema.projects.id, row.projectId));
    assertCanAccess(principal, project && { ownerUserId: project.ownerUserId, ownerGuestSessionId: null });
  }
  return row;
}

/** Fetches a document's summary (everything but canonical_text) by id. */
export async function getDocumentSummary(db: Db, principal: Principal, documentId: string): Promise<DocumentSummary> {
  const [row] = isUuidShaped(documentId)
    ? await db.select(summaryColumns).from(schema.documents).where(and(
        eq(schema.documents.id, documentId),
        or(isNull(schema.documents.expiresAt), gt(schema.documents.expiresAt, sql`now()`)),
      ))
    : [];
  assertCanAccess(principal, row);
  if (row.projectId) {
    const [project] = await db.select({ ownerUserId: schema.projects.ownerUserId }).from(schema.projects)
      .where(eq(schema.projects.id, row.projectId));
    assertCanAccess(principal, project && { ownerUserId: project.ownerUserId, ownerGuestSessionId: null });
  }
  return row;
}

/** Every document `principal` owns, most recently uploaded first. */
export async function listDocuments(db: Db, principal: Principal): Promise<DocumentSummary[]> {
  const ownerFilter =
    principal.type === "user"
      ? eq(schema.documents.ownerUserId, principal.userId)
      : eq(schema.documents.ownerGuestSessionId, principal.guestSessionId);
  const rows = await db
    .select(summaryColumns)
    .from(schema.documents)
    .where(and(ownerFilter, or(isNull(schema.documents.expiresAt), gt(schema.documents.expiresAt, sql`now()`))))
    .orderBy(desc(schema.documents.uploadedAt), desc(schema.documents.id));
  // The WHERE clause narrows the scan; canAccess stays the authority on what is returned.
  return rows.filter((row) => canAccess(principal, row));
}

/** Extraction output required to move a document from pending to ready. */
export interface DocumentExtraction {
  inputMode: InputMode;
  canonicalText: string;
  canonicalTextHash: string;
  extractorVersion: string;
  documentType: DocumentTypeId;
  detectionConfidence: string;
  jurisdiction: string;
}

/**
 * Only a pending document becomes ready, so canonical_text (and the hash every VerifyResult is bound
 * to) never changes once findings may exist. Returns null if the document already left pending — a
 * concurrent extraction of the same document finished first.
 */
export async function markDocumentReady(
  db: Db,
  principal: Principal,
  documentId: string,
  extraction: DocumentExtraction,
): Promise<Document | null> {
  await getDocumentSummary(db, principal, documentId);
  const [row] = await db
    .update(schema.documents)
    .set({ ...extraction, processingStatus: "ready", updatedAt: sql`now()` })
    .where(and(eq(schema.documents.id, documentId), eq(schema.documents.processingStatus, "pending"),
      principal.type === "user" ? eq(schema.documents.ownerUserId, principal.userId) : eq(schema.documents.ownerGuestSessionId, principal.guestSessionId)))
    .returning();
  return row ?? null;
}

/** Marks a pending document as extraction_failed. No-op for a document that already left pending. */
export async function markDocumentExtractionFailed(db: Db, principal: Principal, documentId: string): Promise<void> {
  await getDocumentSummary(db, principal, documentId);
  await db
    .update(schema.documents)
    .set({ processingStatus: "extraction_failed", updatedAt: sql`now()` })
    .where(and(eq(schema.documents.id, documentId), eq(schema.documents.processingStatus, "pending"),
      principal.type === "user" ? eq(schema.documents.ownerUserId, principal.userId) : eq(schema.documents.ownerGuestSessionId, principal.guestSessionId)));
}
