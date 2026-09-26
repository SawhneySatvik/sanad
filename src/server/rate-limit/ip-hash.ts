/**
 * HMACs the client IP with a server secret so a raw IP is never persisted. Secret resolution
 * mirrors the guest-session secret's own handling (same >=32-byte / non-whitespace floor, same
 * dev-ephemeral-fallback-with-one-time-warning / prod-throws split), reimplemented against its own
 * env var so rotating one secret never silently resets the other's hashed keys.
 *
 * The same primitive also keys the auth-specific per-email rate-limit bucket (limiter.ts): an email
 * address and an IP address never take the same shape, so the two hashed-key spaces can't collide,
 * and reusing this secret means the per-email bucket needs no env var of its own.
 */

import { createHmac, randomBytes } from "node:crypto";
import { ConfigError, optionalEnv } from "@/server/core/env";

const MIN_SECRET_BYTES = 32;
const IP_HASH_SECRET_VAR = "RATE_LIMIT_IP_HASH_SECRET";

// Module-scoped, non-production-only fallback — never caches a *configured* secret (resolveSecret
// re-reads the env var every call); only the synthesized ephemeral secret persists, for this
// process's lifetime.
let ephemeralSecret: Buffer | null = null;
let warnedEphemeralFallback = false;

function isWhitespaceOnly(raw: string): boolean {
  return raw.trim().length === 0;
}

function secretConfigError(reason: string): ConfigError {
  const err = new ConfigError(IP_HASH_SECRET_VAR);
  err.message =
    `${IP_HASH_SECRET_VAR} ${reason}. It keys the client-IP hashes rate limiting uses: set it to a random value of at ` +
    `least ${MIN_SECRET_BYTES} bytes, e.g. the output of \`openssl rand -hex 32\`.`;
  return err;
}

function resolveIpHashSecret(): Buffer {
  const raw = optionalEnv(IP_HASH_SECRET_VAR);
  const isUsable = raw !== undefined && !isWhitespaceOnly(raw) && Buffer.byteLength(raw, "utf8") >= MIN_SECRET_BYTES;

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

  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(MIN_SECRET_BYTES);
  }
  if (!warnedEphemeralFallback) {
    warnedEphemeralFallback = true;
    console.warn(
      `${IP_HASH_SECRET_VAR} is missing or shorter than ${MIN_SECRET_BYTES} bytes — using an ephemeral, ` +
        "per-process secret for local development. IP rate-limit bucket keys will change on the next " +
        `process restart. Set ${IP_HASH_SECRET_VAR} (>= ${MIN_SECRET_BYTES} bytes) before deploying to production.`,
    );
  }
  return ephemeralSecret;
}

function hmac(value: string): string {
  return createHmac("sha256", resolveIpHashSecret()).update(value).digest("base64url");
}

/**
 * Deterministic for a given process's secret — the same input IP always yields the same output key,
 * so a repeat visitor's bucket accumulates correctly — but never reversible to the raw IP.
 */
export function hashIp(ip: string): string {
  return hmac(ip);
}

/** Deterministic for a given process's secret; the email is lowercased first so "Asha@x.com" and "asha@x.com" share one bucket. Never reversible to the raw email. */
export function hashAuthEmail(email: string): string {
  return hmac(email.toLowerCase());
}
