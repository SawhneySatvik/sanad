import type { VerifyBatchResult } from "@/server/services/verify-batch";
import { toVerificationOutput } from "../verification";

// A document the caller can't use arrives with empty text and a not_found result, mapped by the
// same call into the same shape as any other not_found.
/** Maps a VerifyBatchResult to the wire shape, via toVerificationOutput for every result. */
export function verifyBatchView({ results }: VerifyBatchResult) {
  return {
    results: results.map(({ quote, verification, source }) => toVerificationOutput(verification, { quote, ...source })),
  };
}
