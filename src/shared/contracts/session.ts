/**
 * GET /api/session, POST /api/session/sign-out and POST /api/auth/dev-sign-in all answer this same
 * shape: a client-facing session summary carrying no ids, emails or tokens — nothing here can
 * identify a principal to anyone but the signed cookie the server itself reads.
 */

import { z } from "zod";

/**
 * POST /api/auth/dev-sign-in's request body: a display name only. The 1-500 bound here is a cheap
 * edge sanity check, not the real one — the service strips control/bidi characters and trims before
 * enforcing the real 1-120 bound, so a raw length just inside 500 can still fail there.
 */
export const DevSignInInput = z.strictObject({
  displayName: z.string().min(1).max(500),
});
export type DevSignInInput = z.infer<typeof DevSignInInput>;

/** GET /api/session, POST /api/session/sign-out and POST /api/auth/dev-sign-in's shared response. */
export const SessionOutput = z.object({
  kind: z.enum(["guest", "user"]),
  displayName: z.string().optional(),
  signInAvailable: z.boolean(),
  guestTtlHours: z.number().positive(),
});
export type SessionOutput = z.infer<typeof SessionOutput>;
