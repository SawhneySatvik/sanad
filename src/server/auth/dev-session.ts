/**
 * Dev-only sign-in identity: a second, independent signed httpOnly cookie for a real `users` row,
 * refused entirely in production — the same "throws at construction" shape as db/client.ts's PGlite
 * refusal. Mirrors session.ts's guest-cookie signing discipline (an id, an HMAC over id.issuedAt,
 * timingSafeEqual verification) but with its own secret and, unlike the guest cookie, no production
 * fallback to reach: readDevUserSession refuses in production before any signature check runs, and
 * createDevSignInAdapter refuses to construct before any cookie could ever be signed.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { optionalEnv } from "../core/env";
import type { Principal } from "../core/types";

/** A principal known to be a signed-in user. */
type UserPrincipal = Extract<Principal, { type: "user" }>;

/** The dev user-session cookie's name outside production, where local dev runs over plain http. */
export const DEV_USER_SESSION_COOKIE_NAME = "dev_user_session";

/**
 * The dev user-session cookie's name in production. Never actually reachable — createDevSignInAdapter
 * refuses to construct in production, so nothing ever signs one there — kept only for symmetry with
 * the guest cookie's own __Host- naming rule.
 */
export const HOST_DEV_USER_SESSION_COOKIE_NAME = "__Host-dev_user_session";

// One switch for the name and the Secure flag, exactly as session.ts's guest cookie does.
function secureCookieMode(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The dev user-session cookie name for the current mode. */
export function devUserSessionCookieName(): string {
  return secureCookieMode() ? HOST_DEV_USER_SESSION_COOKIE_NAME : DEV_USER_SESSION_COOKIE_NAME;
}

// A dev tool's session deliberately outlives the guest cookie's 3 hours: a developer signing in to
// exercise signed-in surfaces shouldn't be bumped back to guest mid-session. Still bounded, not eternal.
export const DEV_USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const MIN_SECRET_BYTES = 32;
const DEV_SESSION_SECRET_VAR = "DEV_SESSION_SECRET";

// Tolerance for a cookie whose signed issued-at is slightly in the future — clock skew between
// processes, never a large window. Mirrors session.ts's own tolerance.
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

// deriveDevUserId always sets this exact version/variant; a cookie naming an id that was never
// derived that way (any other version) is rejected outright, before a signature is even checked.
const DEV_USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUED_AT_RE = /^\d{1,15}$/;

// Module-scoped, non-production-only fallback, exactly as session.ts's own — never used to cache a
// configured secret; only the synthesized ephemeral secret persists, for this process's lifetime.
let ephemeralSecret: Buffer | null = null;

function isWhitespaceOnly(raw: string): boolean {
  return raw.trim().length === 0;
}

// No production branch, unlike session.ts's resolveSecret: readDevUserSession refuses in production
// before this ever runs, and createDevSignInAdapter refuses to construct before any cookie could be
// signed — so a missing/short DEV_SESSION_SECRET in production is unreachable code, not a live gap.
function resolveDevSecret(): Buffer {
  const raw = optionalEnv(DEV_SESSION_SECRET_VAR);
  const isUsable = raw !== undefined && !isWhitespaceOnly(raw) && Buffer.byteLength(raw, "utf8") >= MIN_SECRET_BYTES;
  if (isUsable) return Buffer.from(raw as string, "utf8");

  ephemeralSecret ??= randomBytes(MIN_SECRET_BYTES);
  return ephemeralSecret;
}

function hmacSign(secret: Buffer, userId: string, issuedAtRaw: string): string {
  return createHmac("sha256", secret).update(`${userId}.${issuedAtRaw}`).digest("base64url");
}

function sign(userId: string, issuedAtRaw: string): string {
  return hmacSign(resolveDevSecret(), userId, issuedAtRaw);
}

// Compares the base64url text, not decoded bytes — see session.ts's identical check for why.
function signatureMatches(userId: string, issuedAtRaw: string, providedSignature: string): boolean {
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(hmacSign(resolveDevSecret(), userId, issuedAtRaw), "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * A stable id for a sanitized display name: the same name always derives the same id, so "creates or
 * reuses" is a plain `INSERT ... ON CONFLICT DO NOTHING` on the primary key — users.display_name
 * carries no unique constraint (db/schema.ts), so this is what makes the upsert atomic without one.
 * Not a real namespace UUID (no RFC 4122 namespace input): a hash shaped to pass as one, with a fixed
 * version/variant so readDevUserSession can reject anything that was never derived this way.
 */
export function deriveDevUserId(displayName: string): string {
  const digest = createHash("sha256").update(`dev-sign-in:${displayName}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version nibble
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant bits
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A newly minted dev user session: the signed cookie value to set. */
export interface DevUserSession {
  cookieValue: string;
}

function mintDevUserSession(userId: string): DevUserSession {
  const issuedAtRaw = String(Math.floor(Date.now() / 1000));
  return { cookieValue: `${userId}.${issuedAtRaw}.${sign(userId, issuedAtRaw)}` };
}

/**
 * Verifies a dev user-session cookie's signature and TTL.
 * @returns The signed-in user's id, or null if the cookie is missing, tampered, expired, or this is
 * a production process (checked first, unconditionally — see the module doc).
 */
export function readDevUserSession(cookieValue: string | null | undefined): string | null {
  // Checked first, before anything else: a stale dev-signed cookie (a prior dev session, a copied
  // header) must never verify in production, regardless of what secret it happens to match — that
  // holds even if some other guard is ever bypassed.
  if (process.env.NODE_ENV === "production") return null;
  if (!cookieValue) return null;

  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;

  const [userId, issuedAtRaw, providedSignature] = parts;
  if (!DEV_USER_ID_RE.test(userId)) return null;
  if (!ISSUED_AT_RE.test(issuedAtRaw)) return null;
  if (!signatureMatches(userId, issuedAtRaw, providedSignature)) return null;

  const issuedAtSeconds = Number(issuedAtRaw);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (issuedAtSeconds > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) return null;
  if (nowSeconds - issuedAtSeconds > DEV_USER_SESSION_TTL_SECONDS) return null;

  return userId;
}

/** Resolves the user Principal for a dev user-session cookie value, or null if there's no valid one. */
export function resolveUserPrincipalFromCookie(cookieValue: string | null | undefined): UserPrincipal | null {
  const userId = readDevUserSession(cookieValue);
  return userId === null ? null : { type: "user", userId };
}

/** The cookie attributes for a dev user session, ready to pass to Next's cookie-setting APIs. */
export interface DevUserSessionCookieAttributes {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

/** Shaped to drop directly into the same cookie-setting call session.ts's guestSessionCookie does. */
export function devUserSessionCookie(value: string): DevUserSessionCookieAttributes {
  return {
    name: devUserSessionCookieName(),
    value,
    httpOnly: true,
    secure: secureCookieMode(),
    sameSite: "lax",
    path: "/",
    maxAge: DEV_USER_SESSION_TTL_SECONDS,
  };
}

/** The dev sign-in adapter: the one thing that can mint a signed dev user-session cookie. */
export interface DevSignInAdapter {
  signIn(userId: string): DevUserSessionCookieAttributes;
}

/**
 * Builds the dev sign-in adapter. Throws when NODE_ENV is "production" — the same construction-time
 * refusal shape as db/client.ts's createDb, so production can never reach a code path that signs a
 * dev user-session cookie in the first place.
 */
export function createDevSignInAdapter(): DevSignInAdapter {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Dev sign-in is unavailable in production.");
  }
  return { signIn: (userId) => devUserSessionCookie(mintDevUserSession(userId).cookieValue) };
}
