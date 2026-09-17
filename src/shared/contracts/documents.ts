/**
 * POST /api/documents, GET /api/documents/:id, POST /api/documents/:id/analyze. No request schema
 * has a status, span or canonical-text field, and requests are strict. A finding's `verification`
 * is the shared VerificationOutput, cut server-side from the document's canonical text — the only
 * passage a client displays; the model's claimed quote appears only as claimedQuote on
 * approximate/not_found. A finding's explanation is model-written ("ai_generated") or a
 * deterministic standard-clause checklist gap ("checklist"); a lens explanation is always
 * model-written, so it carries `explanationProvenance: "ai_generated"` as a literal.
 */

import { z } from "zod";
import { DOCUMENT_CATEGORIES, INPUT_MODES } from "@/server/core/types";
import { IsoDateTime, VerificationOutput } from "./common";

/** POST /api/documents' request body: the confirmed upload ref to analyze. */
export const AnalyzeDocumentInput = z.strictObject({
  // Validated by the storage adapter's confirmUpload: a malformed, foreign or already-used ref is
  // the same 404.
  storageRef: z.string().min(1).max(1024),
  // Accepted but not used: the document keeps the filename and type declared at POST /api/uploads.
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
});
export type AnalyzeDocumentInput = z.infer<typeof AnalyzeDocumentInput>;

// Deliberately absent: owner columns, storageRef (server-internal; the client already holds the ref
// it uploaded with), canonical text and its hash.
/** A document's wire shape, never its canonical text. */
export const DocumentOutput = z.object({
  id: z.guid(),
  projectId: z.guid().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  processingStatus: z.enum(["pending", "ready", "extraction_failed"]),
  inputMode: z.enum(INPUT_MODES).nullable(),
  documentType: z.string().nullable(),
  jurisdiction: z.string(),
  detectionConfidence: z.string().nullable(),
  uploadedAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
});
export type DocumentOutput = z.infer<typeof DocumentOutput>;

/** One lens's model-written explanation. */
export const LensExplanationOutput = z.object({
  lens: z.string(),
  explanation: z.string(),
  explanationProvenance: z.literal("ai_generated"),
});
export type LensExplanationOutput = z.infer<typeof LensExplanationOutput>;

/**
 * One finding, its verification bound to this document. A "checklist" finding is a standard
 * protection the deterministic checklist found no wording for: not model output, always a quote-less
 * missing_clause with no verification and no per-lens explanations, and `modelUsed` is "none".
 */
export const FindingOutput = z
  .object({
    id: z.guid(),
    category: z.enum(DOCUMENT_CATEGORIES),
    explanation: z.string(),
    explanationProvenance: z.enum(["ai_generated", "checklist"]),
    lensExplanations: z.array(LensExplanationOutput),
    verification: VerificationOutput.nullable(),
    modelUsed: z.string(),
  })
  // An absence quotes nothing, so a checklist finding with a verification is a server bug: the
  // response fails to parse rather than showing a status that verify() never produced.
  .superRefine((finding, ctx) => {
    if (finding.explanationProvenance !== "checklist") return;
    if (finding.category !== "missing_clause" || finding.verification !== null || finding.lensExplanations.length > 0) {
      ctx.addIssue({ code: "custom", message: "A checklist finding is a missing_clause with no verification and no lens explanations." });
    }
  });
export type FindingOutput = z.infer<typeof FindingOutput>;

/** Metadata for one completed analysis. */
export const AnalysisOutput = z.object({
  id: z.guid(),
  promptVersion: z.string(),
  modelUsed: z.string(),
  createdAt: IsoDateTime,
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

const AnalyzedDocumentOutput = z.object({
  analysisState: z.literal("complete"),
  document: DocumentOutput,
  analysis: AnalysisOutput,
  findings: z.array(FindingOutput),
});

// findings: null, never [] — "not analysed" can never read as "analysed, nothing found".
const UnanalyzedDocumentOutput = z.object({
  analysisState: z.literal("not_analyzed"),
  document: DocumentOutput,
  analysis: z.null(),
  findings: z.null(),
});

/** GET /api/documents/:id's response: a document, analyzed or not, discriminated on `analysisState`. */
export const DocumentWithFindingsOutput = z.discriminatedUnion("analysisState", [
  AnalyzedDocumentOutput,
  UnanalyzedDocumentOutput,
]);
export type DocumentWithFindingsOutput = z.infer<typeof DocumentWithFindingsOutput>;

// POST /api/documents only ever answers with a completed analysis; any failure is an error body
// (with the documentId to retry via POST /api/documents/:id/analyze).
/** POST /api/documents' response — always a completed analysis. */
export const AnalyzeDocumentOutput = AnalyzedDocumentOutput;
export type AnalyzeDocumentOutput = z.infer<typeof AnalyzeDocumentOutput>;
