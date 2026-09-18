/**
 * Guest session identity: an httpOnly, CSPRNG-generated, HMAC-signed session cookie — never a
 * client-supplied header — so identity can't be forged by an arbitrary header/query param. No
 * user-principal code path exists here: a `{ type: "user" }` Principal is only ever built from a
 * verified Supabase Auth claim, never trusting request data beyond a cookie's verified signature.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ConfigError, optionalEnv } from "../core/env";
import type { Principal } from "../core/types";

/** The guest session cookie's name outside production, where local dev runs over plain http. */
export const GUEST_SESSION_COOKIE_NAME = "guest_session";

/**
 * The guest session cookie's name in production. A browser only stores a `__Host-` cookie that is
 * Secure, Path=/ and has no Domain, so a sibling subdomain or a plain-http response can't plant one
 * to fix a victim's session.
 */
export const HOST_GUEST_SESSION_COOKIE_NAME = "__Host-guest_session";

// One switch for the name and the Secure flag: a browser drops a __Host- cookie that isn't Secure.
function secureCookieMode(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The guest session cookie name for the current mode; the only name a request's cookie is read under. */
export function guestSessionCookieName(): string {
  return secureCookieMode() ? HOST_GUEST_SESSION_COOKIE_NAME : GUEST_SESSION_COOKIE_NAME;
}

/** Guest data lives 2-4 hours, this is the midpoint; governs only the cookie's lifetime, not the DB rows' TTL. */
export const GUEST_SESSION_TTL_SECONDS = 3 * 60 * 60; // 3 hours

const MIN_SECRET_BYTES = 32;
const GUEST_SESSION_SECRET_VAR = "GUEST_SESSION_SECRET";
const GUEST_SESSION_SECRET_PREVIOUS_VAR = "GUEST_SESSION_SECRET_PREVIOUS";

// Tolerance for a cookie whose signed issued-at is slightly in the future —
// clock skew between processes/instances, never a large window.
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Module-scoped, non-production-only fallback — not used to cache a configured secret:
// resolveSecret() re-reads GUEST_SESSION_SECRET from the environment on every call; only the
// synthesized ephemeral secret persists, and only for the lifetime of this process.
let ephemeralSecret: Buffer | null = null;
let warnedEphemeralFallback = false;

function secretConfigError(reason: string): ConfigError {
  // Reuses core/env.ts's typed ConfigError (instanceof-checkable) instead of a parallel error type;
  // its default "missing" wording doesn't fit the "too short" case, so the message is overridden
  // after construction, keeping `instanceof ConfigError` intact.
  const err = new ConfigError(GUEST_SESSION_SECRET_VAR);
  err.message =
    `${GUEST_SESSION_SECRET_VAR} ${reason}. It signs guest session cookies: set it to a random value of at least ` +
    `${MIN_SECRET_BYTES} bytes, e.g. the output of \`openssl rand -hex 32\`.`;
  return err;
}

// A secret that's present but entirely whitespace is functionally missing —
// counting its raw byte length would let e.g. 40 spaces pass the length
// check while carrying no real entropy.
function isWhitespaceOnly(raw: string): boolean {
  return raw.trim().length === 0;
}

function resolveSecret(): Buffer {
  const raw = optionalEnv(GUEST_SESSION_SECRET_VAR);
  const isUsable =
    raw !== undefined && !isWhitespaceOnly(raw) && Buffer.byteLength(raw, "utf8") >= MIN_SECRET_BYTES;

  if (isUsable) {
    return Buffer.from(raw as string, "utf8");
  }

  if (process.env.NODE_ENV === "production") {
    throw secretConfigError(
      raw === undefined || isWhitespaceOnly(raw)
        ? "is required in production"
        : `must be at least ${MIN_SECRET_BYTES} bytes in production`,
    );
  }

  // Outside production: fall back to an ephemeral, per-process, CSPRNG secret so local dev/tests
  // work with zero env setup. Logged once — never the configured value itself, since a short-but-
  // present secret could still be operator-meaningful text.
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(MIN_SECRET_BYTES);
  }
  if (!warnedEphemeralFallback) {
    warnedEphemeralFallback = true;
    // Deliberate one-time operator warning — never logs the secret value itself.
    console.warn(
      `${GUEST_SESSION_SECRET_VAR} is missing or shorter than ${MIN_SECRET_BYTES} bytes — using an ` +
        "ephemeral, per-process secret for local development. Existing guest session cookies will " +
        `stop verifying on the next process restart. Set ${GUEST_SESSION_SECRET_VAR} (>= ${MIN_SECRET_BYTES} ` +
        "bytes) before deploying to production.",
    );
  }
  return ephemeralSecret;
}

// Rotation grace period: an optional, verify-only previous secret, checked only when the current
// secret's signature doesn't match, so rotating GUEST_SESSION_SECRET doesn't invalidate every live
// session immediately. Absent/too-short is silently ignored — best-effort, so it never throws.
function resolvePreviousSecret(): Buffer | null {
  const raw = optionalEnv(GUEST_SESSION_SECRET_PREVIOUS_VAR);
  if (raw === undefined || isWhitespaceOnly(raw) || Buffer.byteLength(raw, "utf8") < MIN_SECRET_BYTES) {
    return null;
  }
  return Buffer.from(raw, "utf8");
}

// Signs `id.issuedAt`, not just the id, so a stolen-but-correctly-signed cookie can be rejected once
// it's older than the TTL server-side — Max-Age is only ever a hint to the client, not enforced.
function hmacSign(secret: Buffer, guestSessionId: string, issuedAtRaw: string): string {
  return createHmac("sha256", secret).update(`${guestSessionId}.${issuedAtRaw}`).digest("base64url");
}

function sign(guestSessionId: string, issuedAtRaw: string): string {
  return hmacSign(resolveSecret(), guestSessionId, issuedAtRaw);
}

// Compares the base64url text, not decoded bytes: decode-then-compare could accept a tampered
// signature that happens to decode to the same bytes as a valid one. Length-checked before
// timingSafeEqual (which throws on a length mismatch) — safe outside constant time since length isn't secret.
function signatureMatches(
  secret: Buffer,
  guestSessionId: string,
  issuedAtRaw: string,
  providedSignature: string,
): boolean {
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(hmacSign(secret, guestSessionId, issuedAtRaw), "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** A newly minted guest session: its id and the signed cookie value to set. */
export type GuestSession = {
  guestSessionId: string;
  cookieValue: string;
};

/**
 * Mints a new guest session: `crypto.randomUUID()` gives 122 bits of CSPRNG randomness for the id.
 * The cookie value is `id.issuedAt.signature` — issuedAt (unix seconds) is signed alongside the id so
 * expiry can be enforced server-side, not just by the browser's Max-Age.
 */
export function createGuestSession(): GuestSession {
  const guestSessionId = randomUUID();
  const issuedAtRaw = String(Math.floor(Date.now() / 1000));
  const signature = sign(guestSessionId, issuedAtRaw);
  return { guestSessionId, cookieValue: `${guestSessionId}.${issuedAtRaw}.${signature}` };
}

// Bounded so an attacker can't hand in an absurdly long digit string.
const ISSUED_AT_RE = /^\d{1,15}$/;

/** Verifies a guest session cookie's signature and TTL. @returns The guest session id, or null if the cookie is missing, tampered, or expired. */
export function readGuestSession(cookieValue: string | null | undefined): string | null {
  if (!cookieValue) return null;

  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;

  const [guestSessionId, issuedAtRaw, providedSignature] = parts;
  if (!UUID_V4_RE.test(guestSessionId)) return null;
  if (!ISSUED_AT_RE.test(issuedAtRaw)) return null;

  let signatureValid = signatureMatches(resolveSecret(), guestSessionId, issuedAtRaw, providedSignature);
  if (!signatureValid) {
    const previousSecret = resolvePreviousSecret();
    if (previousSecret) {
      signatureValid = signatureMatches(previousSecret, guestSessionId, issuedAtRaw, providedSignature);
    }
  }
  if (!signatureValid) return null;

  // Only trust issuedAt for the expiry check once the signature above has
  // proven it wasn't tampered with.
  const issuedAtSeconds = Number(issuedAtRaw);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (issuedAtSeconds > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) return null;
  if (nowSeconds - issuedAtSeconds > GUEST_SESSION_TTL_SECONDS) return null;

  return guestSessionId;
}

/** The cookie attributes for a guest session, ready to pass to Next's cookie-setting APIs. */
export type GuestSessionCookieAttributes = {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

/**
 * Shaped to drop directly into Next's `cookies().set({ ...attrs })` / `NextResponse.cookies.set({
 * ...attrs })`. Only produces the attributes; never touches a request.
 */
export function guestSessionCookie(value: string): GuestSessionCookieAttributes {
  return {
    name: guestSessionCookieName(),
    value,
    httpOnly: true,
    secure: secureCookieMode(),
    sameSite: "lax",
    path: "/",
    maxAge: GUEST_SESSION_TTL_SECONDS,
  };
}

/** Resolves the guest Principal for a cookie value, or null if there's no valid guest session. */
export function resolvePrincipalFromCookie(cookieValue: string | null | undefined): Principal | null {
  const guestSessionId = readGuestSession(cookieValue);
  if (guestSessionId === null) return null;
  return { type: "guest", guestSessionId };
}
