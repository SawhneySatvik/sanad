import { z } from "zod";

/**
 * POST /api/auth/claim's response: the counts claimGuestSession returns, all zero when there's a
 * user but no guest session. No signed-in user never reaches this shape — that's a 400 instead.
 */
export const ClaimResultOutput = z.object({
  documents: z.number().int().nonnegative(),
  comparisons: z.number().int().nonnegative(),
  drafts: z.number().int().nonnegative(),
});
export type ClaimResultOutput = z.infer<typeof ClaimResultOutput>;
