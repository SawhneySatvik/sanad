/**
 * POST /api/samples/:sampleId/open's own wire contract. `sampleId` is a fixed registry id, never a
 * document id, so it isn't IdParams' z.guid().
 */

import { z } from "zod";

export const SampleIdParams = z.strictObject({ sampleId: z.string().min(1).max(100) });
export type SampleIdParams = z.infer<typeof SampleIdParams>;

/** The only field the open route returns — the client reads everything else through the ordinary document GET. */
export const SampleOpenOutput = z.object({ documentId: z.guid() });
export type SampleOpenOutput = z.infer<typeof SampleOpenOutput>;
