/**
 * The production account-session cookie: a real, Supabase-authenticated `users` row's own signed
 * httpOnly cookie — distinct from the dev-only cookie (dev-session.ts, refused in production) and
 * from the guest cookie (session.ts). Mirrors both's cookie shape (`id.issuedAt.signature`) but the
 * signed message is prefixed ("user-session:") so a signature can never be replayed across cookie
 * kinds even if two secrets ever matched, its own secret (USER_SESSION_SECRET) is checked to never
 * equal GUEST_SESSION_SECRET (isUsableSecret fails closed if it does — both sign the same-shaped
 * `<v4-uuid>.<issuedAt>` message, so a shared secret would let a guest cookie's signature double as
 * a valid account one for the same id), and it carries a longer TTL, since a signed-in user is not a
 * 2-4 hour guest. The read path (readUserSession, used on every request via the auth hook) never
 * throws — a missing/short/colliding secret reads as "no valid session," so a mid-deploy env gap
 * degrades a signed-in caller to guest, never a 500 on every request. Only the mint path
 * (requireUserSessionSecret) throws, and only when a sign-in/sign-up is actually completing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { optionalEnv, ConfigError } from "../core/env";
import type { Principal } from "../core/types";

type UserPrincipal = Extract<Principal, { type: "user" }>;

export const USER_SESSION_COOKIE_NAME = "user_session";
export const HOST_USER_SESSION_COOKIE_NAME = "__Host-user_session";

function secureCookieMode(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The account-session cookie name for the current mode. */
export function userSessionCookieName(): string {
  return secureCookieMode() ? HOST_USER_SESSION_COOKIE_NAME : USER_SESSION_COOKIE_NAME;
}

// A signed-in account outlives a guest session but isn't eternal — a week, forcing a fresh sign-in
// rather than an indefinitely replayable cookie.
export const USER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const MIN_SECRET_BYTES = 32;
const USER_SESSION_SECRET_VAR = "USER_SESSION_SECRET";
const GUEST_SESSION_SECRET_VAR = "GUEST_SESSION_SECRET";
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

// Supabase's own auth.users.id is a random (v4) UUID — the same shape session.ts's guest id takes.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISSUED_AT_RE = /^\d{1,15}$/;

function isWhitespaceOnly(raw: string): boolean {
  return raw.trim().length === 0;
}

// Fails closed (never usable) when USER_SESSION_SECRET equals GUEST_SESSION_SECRET, byte for byte:
// both modules sign the identical-shaped `<v4-uuid>.<issuedAt>` message, so one shared secret would
// let either cookie's signature verify as the other kind for the same id. Checked here — the single
// predicate every mint, read and availability check below goes through — not only at mint time.
function isUsableSecret(raw: string | undefined): raw is string {
  if (raw === undefined || isWhitespaceOnly(raw) || Buffer.byteLength(raw, "utf8") < MIN_SECRET_BYTES) return false;
  return raw !== optionalEnv(GUEST_SESSION_SECRET_VAR);
}

/** Whether USER_SESSION_SECRET is configured and long enough — never throws, safe to call on every request. */
export function hasUsableUserSessionSecret(): boolean {
  return isUsableSecret(optionalEnv(USER_SESSION_SECRET_VAR));
}

/**
 * Whether real (Supabase) email/password sign-in can work at all: every Supabase env var it needs
 * is present, and USER_SESSION_SECRET is usable — without this, a sign-in would succeed against
 * Supabase and then fail to mint our own cookie. Never throws.
 */
export function emailSignInAvailable(): boolean {
  return (
    optionalEnv("SUPABASE_PROJECT_URL") !== undefined &&
    optionalEnv("SUPABASE_PUBLISHABLE_KEY") !== undefined &&
    optionalEnv("SUPABASE_JWKS_URL") !== undefined &&
    hasUsableUserSessionSecret()
  );
}

/**
 * The secret to sign a fresh cookie with.
 * @throws ConfigError if USER_SESSION_SECRET is missing or under 32 bytes — called only when a
 * sign-in/sign-up is actually completing, never on the read path.
 */
export function requireUserSessionSecret(): Buffer {
  const raw = optionalEnv(USER_SESSION_SECRET_VAR);
  if (!isUsableSecret(raw)) {
    const err = new ConfigError(USER_SESSION_SECRET_VAR);
    err.message =
      `${USER_SESSION_SECRET_VAR} is required to sign in: set it to a random value of at least ` +
      `${MIN_SECRET_BYTES} bytes, e.g. the output of \`openssl rand -hex 32\`.`;
    throw err;
  }
  return Buffer.from(raw, "utf8");
}

// Never throws: a missing/short secret here just means no cookie can verify — the caller falls
// back to guest, exactly as an absent cookie would.
function readSecretOrNull(): Buffer | null {
  const raw = optionalEnv(USER_SESSION_SECRET_VAR);
  return isUsableSecret(raw) ? Buffer.from(raw, "utf8") : null;
}

// Prefixed so this signed message can never be the same bytes session.ts's guest-cookie HMAC signs
// over (`<id>.<issuedAt>`, the identical shape) — domain separation that holds even if the two
// secrets were ever equal, which isUsableSecret above now refuses to let happen anyway.
function hmacSign(secret: Buffer, userId: string, issuedAtRaw: string): string {
  return createHmac("sha256", secret).update(`user-session:${userId}.${issuedAtRaw}`).digest("base64url");
}

function signatureMatches(secret: Buffer, userId: string, issuedAtRaw: string, providedSignature: string): boolean {
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(hmacSign(secret, userId, issuedAtRaw), "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** A freshly minted account session's signed cookie value. */
export interface UserSession {
  cookieValue: string;
}

/**
 * Mints a signed account-session cookie value for `userId`.
 * @throws ConfigError via requireUserSessionSecret if USER_SESSION_SECRET isn't usable.
 */
export function mintUserSession(userId: string): UserSession {
  const secret = requireUserSessionSecret();
  const issuedAtRaw = String(Math.floor(Date.now() / 1000));
  return { cookieValue: `${userId}.${issuedAtRaw}.${hmacSign(secret, userId, issuedAtRaw)}` };
}

/** Verifies an account-session cookie's signature and TTL. @returns the userId, or null if missing, tampered, expired, or the secret isn't configured. */
export function readUserSession(cookieValue: string | null | undefined): string | null {
  if (!cookieValue) return null;
  const secret = readSecretOrNull();
  if (!secret) return null;

  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;

  const [userId, issuedAtRaw, providedSignature] = parts;
  if (!UUID_V4_RE.test(userId)) return null;
  if (!ISSUED_AT_RE.test(issuedAtRaw)) return null;
  if (!signatureMatches(secret, userId, issuedAtRaw, providedSignature)) return null;

  const issuedAtSeconds = Number(issuedAtRaw);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (issuedAtSeconds > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) return null;
  if (nowSeconds - issuedAtSeconds > USER_SESSION_TTL_SECONDS) return null;

  return userId;
}

/** The cookie attributes for an account session, ready to pass to Next's cookie-setting APIs. */
export interface UserSessionCookieAttributes {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

export function userSessionCookie(value: string): UserSessionCookieAttributes {
  return {
    name: userSessionCookieName(),
    value,
    httpOnly: true,
    secure: secureCookieMode(),
    sameSite: "lax",
    path: "/",
    maxAge: USER_SESSION_TTL_SECONDS,
  };
}

/** Resolves the account Principal for a cookie value, or null if there's no valid one. */
export function resolveUserPrincipalFromCookie(cookieValue: string | null | undefined): UserPrincipal | null {
  const userId = readUserSession(cookieValue);
  return userId === null ? null : { type: "user", userId };
}
