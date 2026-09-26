/**
 * Analyses repository plus the analysis result cache, both authorized through the document they
 * belong to. `analyses` carries UNIQUE(document_id, prompt_version, model_used) so two concurrent
 * runs can't both persist findings. The cache holds only raw, pre-verification output — untrusted,
 * since every caller re-runs verify() — keyed by document content so identical text shares an entry.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { assertCanAccess } from "./access";
import { getDocumentSummary, type DocumentSummary } from "./documents";

/** A persisted analysis row, as read from the database. */
export type Analysis = typeof schema.analyses.$inferSelect;

/** Fields required to record a new analysis run. */
export interface NewAnalysisInput {
  documentId: string;
  promptVersion: string;
  modelUsed: string;
}

/**
 * Keeps claim and delete behind analysis persistence until its transaction commits. NO KEY UPDATE,
 * not SHARE: the same transaction later bumps documents.updated_at, and two persisters each holding
 * SHARE would both wait on the other's lock for that UPDATE — a deadlock. NO KEY UPDATE serializes
 * persisters of one document while still conflicting with the FOR UPDATE claim and delete take.
 */
export async function lockDocumentForAnalysisPersistence(tx: Db, principal: Principal, documentId: string): Promise<void> {
  const [locked] = await tx.select({ ownerUserId: schema.documents.ownerUserId,
    ownerGuestSessionId: schema.documents.ownerGuestSessionId, expiresAt: schema.documents.expiresAt })
    .from(schema.documents).where(eq(schema.documents.id, documentId)).for("no key update");
  assertCanAccess(principal, locked);
  if (locked.expiresAt !== null && locked.expiresAt.getTime() <= Date.now()) throw notFound();
  await getDocumentSummary(tx, principal, documentId);
}

/** Returns null when a run for the same (document, prompt_version, model_used) already exists — the caller lost a race and must not write findings of its own. */
export async function insertAnalysisIfAbsent(db: Db, principal: Principal, input: NewAnalysisInput): Promise<Analysis | null> {
  await getDocumentSummary(db, principal, input.documentId);
  const [row] = await db
    .insert(schema.analyses)
    .values(input)
    .onConflictDoNothing({
      target: [schema.analyses.documentId, schema.analyses.promptVersion, schema.analyses.modelUsed],
    })
    .returning();
  if (row) await db.update(schema.documents).set({ updatedAt: sql`now()` }).where(eq(schema.documents.id, input.documentId));
  return row ?? null;
}

/** Most recent run for the document, optionally limited to one prompt version. */
export async function findLatestAnalysis(
  db: Db,
  principal: Principal,
  documentId: string,
  promptVersion?: string,
): Promise<Analysis | null> {
  await getDocumentSummary(db, principal, documentId);
  const conditions = [eq(schema.analyses.documentId, documentId)];
  if (promptVersion !== undefined) conditions.push(eq(schema.analyses.promptVersion, promptVersion));
  const [row] = await db
    .select()
    .from(schema.analyses)
    .where(and(...conditions))
    .orderBy(desc(schema.analyses.createdAt), desc(schema.analyses.id))
    .limit(1);
  return row ?? null;
}

/** Base TTL for a cached analysis. Guest documents cap this further, to their own expires_at. */
export const ANALYSIS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The components hashed into an analysis cache key. */
export interface AnalysisCacheKeyParts {
  canonicalTextHash: string;
  documentType: string;
  jurisdiction: string;
  promptVersion: string;
  modelId: string;
}

/** Hashes (canonicalTextHash, documentType, jurisdiction, promptVersion, modelId) as a JSON array, so no component can bleed into the next. */
export function analysisCacheKey(parts: AnalysisCacheKeyParts): string {
  const encoded = JSON.stringify([
    parts.canonicalTextHash,
    parts.documentType,
    parts.jurisdiction,
    parts.promptVersion,
    parts.modelId,
  ]);
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function cacheKeyFor(document: DocumentSummary, promptVersion: string, modelId: string): string {
  if (document.canonicalTextHash === null || document.documentType === null) {
    throw new AppError("INVALID_DOCUMENT", "The document has not been extracted.", { reason: "document_not_ready" });
  }
  return analysisCacheKey({
    canonicalTextHash: document.canonicalTextHash,
    documentType: document.documentType,
    jurisdiction: document.jurisdiction,
    promptVersion,
    modelId,
  });
}

/** A cache hit's stored model output. */
export interface CachedAnalysisOutput {
  rawModelOutput: string;
  modelUsed: string;
  // A caller backfilling a faster tier (understand.ts's Redis read-through) needs this to cap that
  // tier's own TTL at what's left of this row's — never longer than the Postgres retention it's
  // standing in for, including a guest document's own tighter, document-capped expiry.
  expiresAt: Date;
}

/** Looks up a non-expired cached analysis output for the given document, prompt, and model. */
export async function getCachedAnalysisOutput(
  db: Db,
  principal: Principal,
  documentId: string,
  lookup: { promptVersion: string; modelId: string },
): Promise<CachedAnalysisOutput | null> {
  const document = await getDocumentSummary(db, principal, documentId);
  const [row] = await db
    .select({
      rawModelOutput: schema.analyzedResultCache.rawModelOutput,
      modelUsed: schema.analyzedResultCache.modelUsed,
      expiresAt: schema.analyzedResultCache.expiresAt,
    })
    .from(schema.analyzedResultCache)
    .where(
      and(
        eq(schema.analyzedResultCache.cacheKey, cacheKeyFor(document, lookup.promptVersion, lookup.modelId)),
        gt(schema.analyzedResultCache.expiresAt, sql`now()`),
      ),
    );
  return row ?? null;
}

/** Writes (or overwrites) the cached output, keyed by the model that actually answered — a fallback model's output is never served to a lookup for the primary model. */
export async function putCachedAnalysisOutput(
  db: Db,
  principal: Principal,
  documentId: string,
  entry: { promptVersion: string; modelUsed: string; rawModelOutput: string },
): Promise<void> {
  const document = await getDocumentSummary(db, principal, documentId);
  const cacheKey = cacheKeyFor(document, entry.promptVersion, entry.modelUsed);
  const ttlExpiry = new Date(Date.now() + ANALYSIS_CACHE_TTL_SECONDS * 1000);
  const expiresAt = document.expiresAt !== null && document.expiresAt < ttlExpiry ? document.expiresAt : ttlExpiry;
  // Every column is overwritten, so a row never mixes one writer's output with another's expiry.
  await db
    .insert(schema.analyzedResultCache)
    .values({ cacheKey, rawModelOutput: entry.rawModelOutput, modelUsed: entry.modelUsed, expiresAt })
    .onConflictDoUpdate({
      target: schema.analyzedResultCache.cacheKey,
      set: { rawModelOutput: entry.rawModelOutput, modelUsed: entry.modelUsed, expiresAt, createdAt: sql`now()` },
    });
}
