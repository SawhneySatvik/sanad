/**
 * POST /api/documents/:id/prepare. Three distinct typed states, discriminated on `state` — never an
 * empty "complete" list standing in for "not analysed" or "nothing grounded to work with"; only
 * `complete` carries lawyerQuestions/checklist/markdown at all. A finding reference's
 * `verification` is prepareService's own shape, not the shared VerificationOutput: Prepare only
 * offers eligible findings (never not_found), so there is no model claim to show next to a verified
 * span. Only the document's id travels on the wire, never its canonical text.
 */

import { z } from "zod";
import { DOCUMENT_CATEGORIES } from "@/server/core/types";
import { LENS_STAGES, LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";

// Every lens id across every document type — a request naming an id from this set is at least a
// real lens somewhere; services/prepare.ts still checks it against the specific document's own type
// after the ownership check, so a lens of the wrong type for a foreign document never distinguishes
// itself from a foreign document with no lens at all (both come back 404).
const ALL_LENS_IDS = [...new Set(Object.values(LENSES_BY_DOCUMENT_TYPE).flatMap((lenses) => lenses.map((lens) => lens.id)))];

// Only "verified"/"approximate": a "not_found" finding is never offered to the model, so a
// spanless/statusless shape here would only mean a service regression — this union makes that a
// hard parse failure, never a silently-accepted malformed citation.
const PrepareVerificationOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    spanStart: z.number().int().nonnegative(),
    spanEnd: z.number().int().nonnegative(),
    spanText: z.string(),
    verifierVersion: z.string(),
  }),
  z.object({
    status: z.literal("approximate"),
    spanStart: z.number().int().nonnegative(),
    spanEnd: z.number().int().nonnegative(),
    spanText: z.string(),
    verifierVersion: z.string(),
  }),
]);

const PrepareFindingRefOutput = z.object({
  id: z.guid(),
  category: z.enum(DOCUMENT_CATEGORIES),
  // null only for a missing_clause finding — there is nothing to verify.
  verification: PrepareVerificationOutput.nullable(),
});

// The reader lens the output was written for — never the model's choice, always the id the caller
// asked for (or the document type's first lens by default), echoed so the client can show it.
const PrepareLensOutput = z.object({
  id: z.string(),
  role: z.string(),
  stage: z.enum(LENS_STAGES),
});

// A real constant, not an approximation: a `complete` result only ever exists after a successful
// LLM call (no_grounded_findings is chosen instead whenever there's nothing to ask the model), so
// every question here is model text.
const PrepareQuestionOutput = z.object({
  question: z.string(),
  whyItMatters: z.string(),
  provenance: z.literal("ai_generated"),
  findingIds: z.array(z.guid()),
  findings: z.array(PrepareFindingRefOutput),
});

const PrepareChecklistItemOutput = z.object({
  item: z.string(),
  provenance: z.literal("ai_generated"),
  findingIds: z.array(z.guid()),
  findings: z.array(PrepareFindingRefOutput),
});

const PrepareCompleteOutput = z.object({
  state: z.literal("complete"),
  documentId: z.guid(),
  lens: PrepareLensOutput,
  // Never both empty (prepare.ts throws SCHEMA_FAILED first) — not re-asserted here; the state
  // itself is the never-empty guarantee (a "complete" with nothing to show never leaves the service).
  lawyerQuestions: z.array(PrepareQuestionOutput),
  checklist: z.array(PrepareChecklistItemOutput),
  modelUsed: z.string(),
  promptVersion: z.string(),
  // Plain text: the renderer adds its own fixed prefixes/labels and strips any badge glyphs before
  // this contract ever sees it; never rendered as raw HTML.
  markdown: z.string(),
});

const PrepareNotAnalyzedOutput = z.object({
  state: z.literal("not_analyzed"),
  documentId: z.guid(),
});

const PrepareNoGroundedFindingsOutput = z.object({
  state: z.literal("no_grounded_findings"),
  documentId: z.guid(),
});

/** POST /api/documents/:id/prepare's response: complete, not_analyzed, or no_grounded_findings. */
export const PrepareOutput = z.discriminatedUnion("state", [
  PrepareCompleteOutput,
  PrepareNotAnalyzedOutput,
  PrepareNoGroundedFindingsOutput,
]);
export type PrepareOutput = z.infer<typeof PrepareOutput>;

/**
 * POST /api/documents/:id/prepare's optional query, `?lens=<lens id>`: which reader lens to write the
 * output for; omitted, the document's type's first lens. A query rather than a body so the call
 * without one stays bodiless. `lens` must be a real lens id of SOME document type here;
 * services/prepare.ts checks it against this document's own type, after the ownership check.
 */
export const PrepareQuery = z.strictObject({
  lens: z.enum(ALL_LENS_IDS).optional(),
});
export type PrepareQuery = z.infer<typeof PrepareQuery>;
