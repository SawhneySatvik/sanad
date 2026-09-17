/**
 * POST /api/verify-batch: fresh verify() results for a reopened guest thread's citations. Requests
 * are strict, so a client-sent status, span or cached "verified" text is a 400, never read.
 * `results[i]` answers `citations[i]`: the shared VerificationOutput, built against the cited
 * document's live canonical text. A citation of a document the caller can't read is not_found, so
 * the endpoint can't answer "does someone else's document contain this string".
 */

import { z } from "zod";
import { VerificationOutput } from "./common";

// Mirror the verify-batch service's own caps, as literals since contracts don't import server
// code; a test pins them equal.
/** Max citations in one verify-batch request. */
export const VERIFY_BATCH_MAX_CITATIONS = 50;
/** Max distinct documents across one request's citations. */
export const VERIFY_BATCH_MAX_DOCUMENTS = 5;
/** Max characters in one citation's quote; a longer one fails the request body, before verify() ever runs. */
export const VERIFY_BATCH_MAX_QUOTE_CHARS = 4_000;
/** Max documentId length — bounds what a client can make the server hold. */
export const VERIFY_BATCH_MAX_DOCUMENT_ID_CHARS = 64;

/**
 * POST /api/verify-batch's request body; documentId is any string, so a malformed id is a
 * not_found citation, not a failed batch.
 */
export const VerifyBatchInput = z.strictObject({
  citations: z
    .array(
      z.strictObject({
        documentId: z.string().max(VERIFY_BATCH_MAX_DOCUMENT_ID_CHARS),
        quote: z.string().max(VERIFY_BATCH_MAX_QUOTE_CHARS),
      }),
    )
    .max(VERIFY_BATCH_MAX_CITATIONS)
    .refine((citations) => new Set(citations.map((c) => c.documentId)).size <= VERIFY_BATCH_MAX_DOCUMENTS),
});
export type VerifyBatchInput = z.infer<typeof VerifyBatchInput>;

/** POST /api/verify-batch's response: one VerificationOutput per input citation, in the same order. */
export const VerifyBatchOutput = z.object({
  results: z.array(VerificationOutput),
});
export type VerifyBatchOutput = z.infer<typeof VerifyBatchOutput>;
