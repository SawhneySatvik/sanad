/**
 * The one service call behind POST /api/auth/claim: on sign-in, re-owns a guest's documents,
 * comparisons and drafts to the signed-in user. No signed-in user throws a typed, detail-free
 * error; no valid guest session returns zero counts with no DB work; both present hands off to
 * claimGuestData's own re-owning transaction.
 *
 * Precondition this file does not enforce: `claim.user.userId` must already have a `users` row, or
 * claimGuestData's UPDATE fails its FK constraint as a raw driver error instead of a clean rejection.
 */

import type { Db } from "@/db/client";
import { claimGuestData, type ClaimResult, type GuestPrincipal, type UserPrincipal } from "@/server/auth/claim";
import { AppError } from "@/server/core/errors";

/** Both identities the claim route resolved, independently, before calling in. */
export interface ClaimSession {
  user: UserPrincipal | null;
  guest: GuestPrincipal | null;
}

/** Re-owns a guest session's data to the signed-in user; see the module doc for each case. */
export async function claimGuestSession(deps: { db: Db }, claim: ClaimSession): Promise<ClaimResult> {
  if (!claim.user) {
    // Fixed, generic message — errors.ts's mapError never puts AppError#message on the wire anyway
    // (it always answers safeMessageFor(code)), but this stays detail-free regardless.
    throw new AppError("VALIDATION_FAILED", "Sign in to claim your guest session.");
  }
  if (!claim.guest) return { documents: 0, comparisons: 0, drafts: 0 };
  return claimGuestData(deps.db, claim.guest, claim.user);
}
