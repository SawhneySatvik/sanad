/**
 * POST /api/comparisons, GET /api/comparisons/:id. CreateComparisonInput is strict: a client can
 * never submit modelUsed, status, span or canonical text. There is no top-level quoteA/quoteB — a
 * side's presence is `verificationX !== null`, and the model's own claim (when it didn't land
 * verified) is `verificationX.claimedQuote`. Only the two documents' ids travel on the wire, never
 * their canonical text.
 */

import { z } from "zod";
import { IsoDateTime, VerificationOutput } from "./common";

// documentAId/documentBId stay a bounded z.string(), not z.guid(): a body field's validation
// failure is 400, but the repository already turns a non-uuid id into the same NOT_FOUND a
// missing/foreign one gets — z.guid() here would break that byte-identical set.
/** POST /api/comparisons' request body. */
export const CreateComparisonInput = z.strictObject({
  documentAId: z.string().min(1).max(64),
  documentBId: z.string().min(1).max(64),
});
export type CreateComparisonInput = z.infer<typeof CreateComparisonInput>;

const ComparisonChangeOutput = z.object({
  id: z.guid(),
  changeType: z.enum(["added", "removed", "changed"]),
  explanation: z.string(),
  explanationProvenance: z.enum(["ai_generated", "templated"]),
  // null signals absence — there is no separate quoteA/quoteB.
  verificationA: VerificationOutput.nullable(),
  verificationB: VerificationOutput.nullable(),
});

/** A comparison with every change, each side's verification bound to its own document. */
export const ComparisonWithChangesOutput = z.object({
  id: z.guid(),
  title: z.string(),
  titleA: z.string(),
  titleB: z.string(),
  documentAId: z.guid(),
  documentBId: z.guid(),
  modelUsed: z.string(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  changes: z.array(ComparisonChangeOutput),
});
export type ComparisonWithChangesOutput = z.infer<typeof ComparisonWithChangesOutput>;

/** POST /api/comparisons' response — the same shape as ComparisonWithChangesOutput. */
export const ComparisonOutput = ComparisonWithChangesOutput;
export type ComparisonOutput = ComparisonWithChangesOutput;
