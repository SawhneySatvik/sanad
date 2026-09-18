/**
 * Finding lens explanations repository. A lens row is only framing text for a finding — no quote,
 * status, or span of its own; verify() runs once per finding, never per lens. Authorized through the
 * document the finding belongs to.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { newId } from "../../db/ids";
import * as schema from "../../db/schema";
import { notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { getDocumentSummary, isUuidShaped } from "./documents";

/** A persisted lens explanation row, as read from the database. */
export type FindingLensExplanation = typeof schema.findingLensExplanations.$inferSelect;

/** One lens explanation to persist for a finding. */
export interface LensExplanationWrite {
  findingId: string;
  roleStageLens: string;
  explanation: string;
}

/** Every finding named must belong to `documentId` — owning one document never lets a caller attach lens rows to a finding of another. */
export async function insertLensExplanations(
  db: Db,
  principal: Principal,
  documentId: string,
  rows: readonly LensExplanationWrite[],
): Promise<FindingLensExplanation[]> {
  await getDocumentSummary(db, principal, documentId);
  if (rows.length === 0) return [];
  const findingIds = [...new Set(rows.map((row) => row.findingId))];
  if (!findingIds.every(isUuidShaped)) throw notFound();
  const owned = await db
    .select({ id: schema.findings.id })
    .from(schema.findings)
    .where(and(eq(schema.findings.documentId, documentId), inArray(schema.findings.id, findingIds)));
  if (owned.length !== findingIds.length) throw notFound();

  // UUIDv7 ids, so listLensExplanations returns rows in the order they were written.
  return db
    .insert(schema.findingLensExplanations)
    .values(rows.map((row) => ({ id: newId(), ...row })))
    .returning();
}

/** All lens explanations for a given analysis of a document, in write order. */
export async function listLensExplanations(
  db: Db,
  principal: Principal,
  documentId: string,
  analysisId: string,
): Promise<FindingLensExplanation[]> {
  await getDocumentSummary(db, principal, documentId);
  if (!isUuidShaped(analysisId)) return [];
  return db
    .select({
      id: schema.findingLensExplanations.id,
      findingId: schema.findingLensExplanations.findingId,
      roleStageLens: schema.findingLensExplanations.roleStageLens,
      explanation: schema.findingLensExplanations.explanation,
    })
    .from(schema.findingLensExplanations)
    .innerJoin(schema.findings, eq(schema.findings.id, schema.findingLensExplanations.findingId))
    .where(and(eq(schema.findings.documentId, documentId), eq(schema.findings.analysisId, analysisId)))
    .orderBy(asc(schema.findingLensExplanations.id));
}
