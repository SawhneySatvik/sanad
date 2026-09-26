/**
 * Supabase Auth over its own REST API — no SDK dependency. signIn/signUp call
 * `${SUPABASE_PROJECT_URL}/auth/v1/{token?grant_type=password,signup}`, then verify the returned
 * access token's signature against SUPABASE_JWKS_URL before trusting anything in it: the user id
 * and email this module hands back always come from the VERIFIED JWT payload, never from the
 * response body's own (unverified, wire-editable) `user` object. Every failure maps to a typed
 * AppError carrying a fixed, generic message — Supabase's own error body/status is read only to
 * pick a code, never logged or echoed, so a password or token can never leak into a log line or a
 * response.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { AppError, safeMessageFor } from "../core/errors";
import { requireEnv } from "../core/env";

declare const verifiedIdentityBrand: unique symbol;

/**
 * The user identity a verified Supabase access token carries. Branded (type-only — nothing is
 * actually set at this key at runtime) so only verifySupabaseAccessToken can produce a value of
 * this type; upsertUser (data/users.ts) takes it instead of a Principal precisely to say "this id
 * was cryptographically verified just now," which is a different claim than "the caller already
 * owns this row" (a Principal + canAccess).
 */
export interface VerifiedIdentity {
  userId: string;
  email: string;
  readonly [verifiedIdentityBrand]: true;
}

const REQUEST_TIMEOUT_MS = 10_000;

function projectUrl(): string {
  // Supabase's own endpoints and `iss` claim never carry a trailing slash — stripped here so both
  // agree whether or not the operator's own env value happens to have one.
  return requireEnv("SUPABASE_PROJECT_URL").replace(/\/+$/, "");
}

interface SupabaseErrorBody {
  error_code?: unknown;
  error?: unknown;
  msg?: unknown;
  error_description?: unknown;
}

async function postToSupabase(path: string, body: unknown): Promise<Response> {
  try {
    return await fetch(`${projectUrl()}${path}`, {
      method: "POST",
      headers: { apikey: requireEnv("SUPABASE_PUBLISHABLE_KEY"), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Never the caught error's own message (could echo request detail) — a fixed, typed mapping.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AppError("TIMEOUT", safeMessageFor("TIMEOUT"));
    }
    throw new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
  }
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function emailAlreadyInUse(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as SupabaseErrorBody;
  const fields = [b.error_code, b.error, b.msg, b.error_description].filter((v): v is string => typeof v === "string");
  return fields.some((v) => /already registered|already exists|user_already_exists/i.test(v));
}

/**
 * Signs in with email/password.
 * @throws AppError INVALID_CREDENTIALS (wrong email/password — deliberately generic, never
 * distinguishing "no such account" from "wrong password"), RATE_LIMITED, TIMEOUT or
 * UPSTREAM_UNAVAILABLE.
 */
export async function signIn(email: string, password: string): Promise<VerifiedIdentity> {
  const res = await postToSupabase("/auth/v1/token?grant_type=password", { email, password });
  if (res.status === 429) throw new AppError("RATE_LIMITED", safeMessageFor("RATE_LIMITED"));
  if (res.status >= 500) throw new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
  if (!res.ok) throw new AppError("INVALID_CREDENTIALS", safeMessageFor("INVALID_CREDENTIALS"));

  const body = (await readJsonBody(res)) as { access_token?: unknown } | null;
  const accessToken = body?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
  }
  const verified = await verifySupabaseAccessToken(accessToken);
  if (!verified) throw new AppError("INVALID_CREDENTIALS", safeMessageFor("INVALID_CREDENTIALS"));
  return verified;
}

/**
 * Creates an account with email/password.
 * @throws AppError EMAIL_IN_USE, EMAIL_CONFIRMATION_REQUIRED (account created, but Supabase's own
 * "Confirm email" setting means there is no session yet), RATE_LIMITED, TIMEOUT,
 * UPSTREAM_UNAVAILABLE, or VALIDATION_FAILED for anything else Supabase rejects the input for.
 */
export async function signUp(email: string, password: string): Promise<VerifiedIdentity> {
  const res = await postToSupabase("/auth/v1/signup", { email, password });
  if (res.status === 429) throw new AppError("RATE_LIMITED", safeMessageFor("RATE_LIMITED"));
  if (res.status >= 500) throw new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));

  const body = await readJsonBody(res);
  if (!res.ok) {
    if (emailAlreadyInUse(body)) throw new AppError("EMAIL_IN_USE", safeMessageFor("EMAIL_IN_USE"));
    throw new AppError("VALIDATION_FAILED", safeMessageFor("VALIDATION_FAILED"));
  }

  const accessToken = (body as { session?: { access_token?: unknown } } | null)?.session?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    // A 2xx with a user but no session: Supabase's "Confirm email" setting is on. Not a client bug,
    // so the generic fallback above (VALIDATION_FAILED) would be wrong — this is its own code.
    throw new AppError("EMAIL_CONFIRMATION_REQUIRED", safeMessageFor("EMAIL_CONFIRMATION_REQUIRED"));
  }
  const verified = await verifySupabaseAccessToken(accessToken);
  if (!verified) throw new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
  return verified;
}

// --- JWKS verification -----------------------------------------------------

interface Jwk {
  kty?: unknown;
  crv?: unknown;
  kid?: unknown;
  [key: string]: unknown;
}

// Keyed by URL (never a bare module-level singleton) so a test can stub a distinct
// SUPABASE_JWKS_URL per case without one test's cache leaking into another's.
const jwksCache = new Map<string, { fetchedAt: number; keys: Jwk[] }>();
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchJwks(url: string): Promise<Jwk[]> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
  }
  if (!res.ok) throw new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
  const body = (await readJsonBody(res)) as { keys?: unknown } | null;
  const keys = Array.isArray(body?.keys) ? (body!.keys as Jwk[]) : [];
  jwksCache.set(url, { fetchedAt: Date.now(), keys });
  return keys;
}

async function cachedJwks(url: string): Promise<Jwk[]> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) return cached.keys;
  return fetchJwks(url);
}

// One refetch on an unknown kid, in case the project rotated its signing key since the last fetch —
// anything still unknown after that is genuinely rejected, not retried again.
async function jwkForKid(url: string, kid: string | undefined): Promise<Jwk | null> {
  const keys = await cachedJwks(url);
  const found = keys.find((k) => k.kid === kid);
  if (found) return found;
  jwksCache.delete(url);
  const refetched = await fetchJwks(url);
  return refetched.find((k) => k.kid === kid) ?? null;
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The same lowercase-v4 check user-session.ts's own cookie parser uses — Supabase's auth.users.id
// is always a v4 UUID, so a `sub` of any other shape (or upper-case hex) never round-trips through
// mintUserSession's own cookie anyway; reject it here rather than at the cookie boundary.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

/**
 * Verifies a Supabase access token's signature (against SUPABASE_JWKS_URL), issuer, audience and
 * expiry using node:crypto only. @returns the verified {userId, email}, or null if anything about
 * the token fails to check out — never throws on a bad token, only on an unreachable JWKS endpoint.
 */
export async function verifySupabaseAccessToken(token: string): Promise<VerifiedIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = base64UrlJson(headerB64);
  const payload = base64UrlJson(payloadB64);
  if (!header || !payload) return null;
  if (header.alg !== "ES256" && header.alg !== "RS256") return null;

  const jwk = await jwkForKid(requireEnv("SUPABASE_JWKS_URL"), typeof header.kid === "string" ? header.kid : undefined);
  if (!jwk) return null;

  // The algorithm is decided by the KEY's own kty/crv, not trusted from the token header — a
  // header claiming ES256 over an RSA key (or vice versa) is rejected here, before verify() runs.
  let nodeAlgorithm: string;
  let dsaEncoding: "ieee-p1363" | undefined;
  if (jwk.kty === "EC" && jwk.crv === "P-256") {
    if (header.alg !== "ES256") return null;
    nodeAlgorithm = "sha256";
    dsaEncoding = "ieee-p1363";
  } else if (jwk.kty === "RSA") {
    if (header.alg !== "RS256") return null;
    nodeAlgorithm = "RSA-SHA256";
  } else {
    return null;
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]);
  } catch {
    return null;
  }

  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(
      nodeAlgorithm,
      Buffer.from(`${headerB64}.${payloadB64}`),
      dsaEncoding ? { key: publicKey, dsaEncoding } : publicKey,
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  const expectedIssuer = `${projectUrl()}/auth/v1`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.iss !== expectedIssuer) return null;
  if (payload.aud !== "authenticated") return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
  // Supabase always issues iat; require and sanity-check it the same way exp is checked, rather
  // than trusting a token that omits the one claim that says when it was minted.
  if (typeof payload.iat !== "number" || payload.iat > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) return null;
  // nbf is optional (Supabase doesn't set it today), but a token that does carry one must honor it.
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS)) return null;
  if (typeof payload.sub !== "string" || !UUID_V4_RE.test(payload.sub)) return null;
  if (typeof payload.email !== "string" || payload.email === "") return null;

  // The cast is the one place this brand is ever bridged — every other caller gets a
  // VerifiedIdentity only by receiving this function's own return value.
  return { userId: payload.sub, email: payload.email } as unknown as VerifiedIdentity;
}
