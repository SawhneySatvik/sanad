/**
 * Who is calling. Three sources of identity, in order: a user from the container's
 * `authenticateUser` hook (production: the real account-session cookie, see
 * accountUserFromCookie/container.ts's productionContainerOptions), a user from the dev-only signed
 * cookie (@/server/auth/dev-session, which refuses itself outright in production), or a guest from
 * the signed, httpOnly guest-session cookie — a missing, tampered or expired cookie mints a fresh
 * one. Nothing else in a request (header, query parameter, body field, unsigned cookie) is ever read
 * as identity.
 */

import {
  createDevSignInAdapter,
  devUserSessionCookie,
  devUserSessionCookieName,
  resolveUserPrincipalFromCookie as resolveDevUserPrincipalFromCookie,
} from "@/server/auth/dev-session";
import {
  createGuestSession,
  guestSessionCookie,
  guestSessionCookieName,
  resolvePrincipalFromCookie,
  type GuestSessionCookieAttributes,
} from "@/server/auth/session";
import {
  mintUserSession,
  resolveUserPrincipalFromCookie as resolveAccountUserPrincipalFromCookie,
  userSessionCookie,
  userSessionCookieName,
} from "@/server/auth/user-session";
import type { Principal } from "@/server/core/types";

/** A principal known to be a signed-in user. */
export type UserPrincipal = Extract<Principal, { type: "user" }>;
/** A principal known to be a guest. */
export type GuestPrincipal = Extract<Principal, { type: "guest" }>;

/** The auth hook: resolves a request's signed-in user, or null. Cannot produce a guest principal. */
export type AuthenticateUser = (req: Request) => Promise<UserPrincipal | null>;

/** The principal a request resolved to, plus a Set-Cookie value if resolving it minted a new guest session. */
export interface ResolvedPrincipal {
  principal: Principal;
  // A Set-Cookie header value when a guest session was just minted; null otherwise.
  setCookie: string | null;
}

/**
 * Resolves the calling principal for one request: the auth hook's user, a valid dev-sign-in user
 * cookie, an existing guest cookie, or a freshly minted guest session — in that order, so the real
 * account-session cookie always outranks the dev-only one.
 */
export async function resolveRequestPrincipal(
  req: Request,
  authenticateUser: AuthenticateUser,
): Promise<ResolvedPrincipal> {
  const hookUser = await authenticateUser(req);
  if (hookUser) return { principal: hookUser, setCookie: null };

  const devUser = devUserFromCookie(req);
  if (devUser) return { principal: devUser, setCookie: null };

  const guest = guestFromCookie(req);
  if (guest) return { principal: guest, setCookie: null };

  const session = createGuestSession();
  return {
    principal: { type: "guest", guestSessionId: session.guestSessionId },
    setCookie: serializeCookie(guestSessionCookie(session.cookieValue)),
  };
}

// Only the current mode's name: in production a plain guest_session cookie, which anything able to
// set a cookie on a sibling subdomain can plant, is never read.
/** The guest a request's signed guest-session cookie proves, or null (missing, tampered, expired). */
export function guestFromCookie(req: Request): GuestPrincipal | null {
  const guest = resolvePrincipalFromCookie(readCookie(req.headers.get("cookie"), guestSessionCookieName()));
  return guest?.type === "guest" ? guest : null;
}

/** The user a request's signed dev-sign-in cookie proves, or null (missing, tampered, expired, or production). */
export function devUserFromCookie(req: Request): UserPrincipal | null {
  return resolveDevUserPrincipalFromCookie(readCookie(req.headers.get("cookie"), devUserSessionCookieName()));
}

/** The user a request's signed account-session cookie proves, or null (missing, tampered, expired, or no secret configured). */
export function accountUserFromCookie(req: Request): UserPrincipal | null {
  return resolveAccountUserPrincipalFromCookie(readCookie(req.headers.get("cookie"), userSessionCookieName()));
}

// First occurrence wins. The value is not URI-decoded: a guest-session value is
// `uuid.digits.base64url`, which never needs it, and anything else fails the signature check anyway.
/** Reads one cookie's raw value from a Cookie header, or null if absent. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

/** Serializes a signed-session cookie's attributes into a Set-Cookie value — guest or dev-user alike (both share this shape). */
export function serializeCookie(cookie: GuestSessionCookieAttributes): string {
  return [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    `Max-Age=${cookie.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(cookie.secure ? ["Secure"] : []),
  ].join("; ");
}

/** The Set-Cookie value for a freshly signed-in dev user; used by the route()'s `userSession: "set"` opt-in. */
export function mintedUserSessionCookie(userId: string): string {
  return serializeCookie(createDevSignInAdapter().signIn(userId));
}

/** The Set-Cookie value that clears the dev user-session cookie; used by route()'s `userSession: "clear"` opt-in. */
export function clearedUserSessionCookie(): string {
  return serializeCookie({ ...devUserSessionCookie(""), maxAge: 0 });
}

/** The Set-Cookie value for a freshly signed-in (Supabase-verified) account; used by `userSession: "set-account"`. */
export function mintedAccountSessionCookie(userId: string): string {
  return serializeCookie(userSessionCookie(mintUserSession(userId).cookieValue));
}

/** The Set-Cookie value that clears the account-session cookie; used by `userSession: "clear"` alongside the dev one. */
export function clearedAccountSessionCookie(): string {
  return serializeCookie({ ...userSessionCookie(""), maxAge: 0 });
}
