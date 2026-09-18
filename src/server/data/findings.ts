/**
 * Findings repository — the only module that writes `findings`. A quoted finding is written only with
 * the VerifyResult verify() issued for exactly that quote against this document's canonical_text and
 * input_mode; status, spans, and verifier_version come from the result alone, never the caller or the
 * model. What's stored is an audit record: readers re-verify, never trusting the stored status.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { newId } from "../../db/ids";
import * as schema from "../../db/schema";
import type { DocumentCategory, Principal } from "../core/types";
import { assertVerifyResultFor, type VerifyResult } from "../deterministic/verify";
import { getDocumentSummary, isUuidShaped } from "./documents";

/** A persisted finding row, as read from the database. */
export type Finding = typeof schema.findings.$inferSelect;

/** One finding to persist for an analysis. */
export interface FindingWrite {
  category: DocumentCategory;
  // null for a finding that quotes nothing (missing_clause): it then has no status at all.
  quote: string | null;
  explanation: string;
  // verify()'s result for exactly `quote` — required when quote is set, null otherwise.
  verification: VerifyResult | null;
}

/** Fields required to persist a batch of findings for one analysis. */
export interface InsertFindingsInput {
  documentId: string;
  analysisId: string;
  modelUsed: string;
  findings: readonly FindingWrite[];
}

/** Returns the rows in input order; ids are UUIDv7 (time-ordered) so callers can attach lens rows by position. */
export async function insertFindings(db: Db, principal: Principal, input: InsertFindingsInput): Promise<Finding[]> {
  const document = await getDocumentSummary(db, principal, input.documentId);
  if (input.findings.length === 0) return [];
  // Both are set together once a document is ready; a missing input_mode is refused, never defaulted.
  const { canonicalTextHash, inputMode } = document;
  if (canonicalTextHash === null || inputMode === null) {
    throw new Error("Findings can only be written for an extracted document");
  }

  const values = input.findings.map((finding) => {
    // A missing clause is text the document does not contain — there is nothing to quote or verify.
    if (finding.category === "missing_clause" && finding.quote !== null) {
      throw new Error("A missing_clause finding cannot quote the document");
    }
    const common = {
      id: newId(),
      documentId: input.documentId,
      analysisId: input.analysisId,
      category: finding.category,
      modelUsed: input.modelUsed,
      explanation: finding.explanation,
    };
    if (finding.quote === null) {
      if (finding.verification !== null) throw new Error("A finding without a quote cannot carry a verification result");
      return {
        ...common,
        quoteText: null,
        quoteSpanStart: null,
        quoteSpanEnd: null,
        verificationStatus: null,
        verifierVersion: null,
      };
    }
    const result = finding.verification;
    // Binding the input mode means a result verify() computed as "text" over a native_document's
    // transcription is refused here, so verify()'s native-document cap reaches storage intact.
    assertVerifyResultFor(result, { quote: finding.quote, canonicalTextHash, inputMode });
    return {
      ...common,
      quoteText: finding.quote,
      quoteSpanStart: result.spanStart,
      quoteSpanEnd: result.spanEnd,
      verificationStatus: result.status,
      verifierVersion: result.verifierVersion,
    };
  });

  const rows = await db.insert(schema.findings).values(values).returning();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return values.map((value) => byId.get(value.id)!);
}

/** All findings for a given analysis of a document, in write order. */
export async function listFindings(
  db: Db,
  principal: Principal,
  documentId: string,
  analysisId: string,
): Promise<Finding[]> {
  await getDocumentSummary(db, principal, documentId);
  if (!isUuidShaped(analysisId)) return [];
  return db
    .select()
    .from(schema.findings)
    .where(and(eq(schema.findings.documentId, documentId), eq(schema.findings.analysisId, analysisId)))
    .orderBy(asc(schema.findings.createdAt), asc(schema.findings.id));
}
