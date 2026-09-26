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
import * as supabaseAuth from "@/server/auth/supabase-auth";
import { emailSignInAvailable } from "@/server/auth/user-session";
import { AppError, notFound } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { upsertUser } from "@/server/data/users";
import { enforceAuthRateLimits } from "@/server/rate-limit/limiter";
import { guestTtlHours } from "@/server/services/session";
import type { EmailPasswordInput } from "@/shared/contracts/auth";
import type { SessionOutput } from "@/shared/contracts/session";

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

/** What POST /api/auth/sign-in and POST /api/auth/sign-up hand their "userSession: set-account" cookie minter. */
export interface AccountSignInResult extends SessionOutput {
  userId: string;
}

// Shared tail of sign-in and sign-up, once each has its own verified Supabase identity: upsert the
// local users row, then — reusing the very same claim path POST /api/auth/claim runs, never a second
// copy of it — re-own whatever the caller's own guest cookie (resolved as `principal` here, exactly
// as every other route sees it) still owns.
async function completeSignIn(deps: { db: Db }, principal: Principal, identity: supabaseAuth.VerifiedIdentity): Promise<AccountSignInResult> {
  const { displayName } = await upsertUser(deps.db, identity);
  const user: UserPrincipal = { type: "user", userId: identity.userId };
  await claimGuestSession(deps, { user, guest: principal.type === "guest" ? principal : null });

  return {
    kind: "user",
    displayName: displayName ?? undefined,
    signInAvailable: true,
    guestTtlHours: guestTtlHours(),
    signInMethod: "email",
    userId: identity.userId,
  };
}

/**
 * POST /api/auth/sign-in: verifies email/password against Supabase, upserts the local user row, and
 * claims the caller's guest data.
 * @throws AppError NOT_FOUND if email sign-in isn't configured; RATE_LIMITED from this route's own
 * per-IP/per-email auth buckets, charged before any Supabase call; INVALID_CREDENTIALS/RATE_LIMITED/
 * TIMEOUT/UPSTREAM_UNAVAILABLE from supabase-auth.ts's own mapping.
 */
export async function signIn(deps: { db: Db; clientIp: string }, principal: Principal, body: EmailPasswordInput): Promise<AccountSignInResult> {
  if (!emailSignInAvailable()) throw notFound();
  await enforceAuthRateLimits(deps.db, deps.clientIp, body.email);
  const identity = await supabaseAuth.signIn(body.email, body.password);
  return completeSignIn(deps, principal, identity);
}

/**
 * POST /api/auth/sign-up: creates the account with Supabase, upserts the local user row, and claims
 * the caller's guest data — unless Supabase's own "Confirm email" setting means there's no session
 * yet (EMAIL_CONFIRMATION_REQUIRED), in which case nothing local is written at all.
 * @throws AppError NOT_FOUND if email sign-in isn't configured; RATE_LIMITED from this route's own
 * per-IP/per-email auth buckets, charged before any Supabase call; EMAIL_IN_USE/
 * EMAIL_CONFIRMATION_REQUIRED/RATE_LIMITED/TIMEOUT/UPSTREAM_UNAVAILABLE/VALIDATION_FAILED from
 * supabase-auth.ts's own mapping.
 */
export async function signUp(deps: { db: Db; clientIp: string }, principal: Principal, body: EmailPasswordInput): Promise<AccountSignInResult> {
  if (!emailSignInAvailable()) throw notFound();
  await enforceAuthRateLimits(deps.db, deps.clientIp, body.email);
  const identity = await supabaseAuth.signUp(body.email, body.password);
  return completeSignIn(deps, principal, identity);
}
