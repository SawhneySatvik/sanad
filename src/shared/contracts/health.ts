import { z } from "zod";

/**
 * GET /api/health's response: whether providers and storage can be built. "ok" means an upload
 * or analysis won't fail on configuration.
 */
export const HealthOutput = z.object({
  status: z.enum(["ok", "degraded"]),
  config: z.object({
    llm: z.boolean(),
    storage: z.boolean(),
  }),
});
export type HealthOutput = z.infer<typeof HealthOutput>;
