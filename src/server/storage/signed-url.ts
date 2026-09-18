/**
 * HMAC-signed, expiring "local storage URL" strings — the local stand-in for Supabase Storage's real
 * signed PUT/GET URLs. Exported standalone, not only as adapter methods, so signing/verification is
 * unit-testable without a filesystem.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const SCHEME = "local-storage:";
const PATHNAME = "/object";

function hmac(secret: string, ref: string, expiresAtMs: number): string {
  return createHmac("sha256", secret).update(`${ref}:${expiresAtMs}`).digest("hex");
}

/** Builds a signed, opaque `local-storage:` URL string encoding `ref` and its expiry. */
export function signLocalUrl(secret: string, ref: string, expiresAtMs: number): string {
  const params = new URLSearchParams({
    ref,
    expires: String(expiresAtMs),
    sig: hmac(secret, ref, expiresAtMs),
  });
  return `${SCHEME}//${PATHNAME}?${params.toString()}`;
}

/** A signed URL's ref and expiry, once verifyLocalUrl has proven the signature and TTL are valid. */
export interface VerifiedLocalUrl {
  ref: string;
  expiresAtMs: number;
}

/**
 * Returns the verified ref on success, `null` on any failure (bad scheme, missing/malformed param,
 * tampered ref/expiry, tampered signature, expired) — never throws, since "not a currently-valid
 * signed URL" is an expected outcome for a route to branch on, not an exceptional one.
 */
export function verifyLocalUrl(
  secret: string,
  url: string,
  nowMs: number = Date.now(),
): VerifiedLocalUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== SCHEME || parsed.pathname !== PATHNAME) {
    return null;
  }
  const ref = parsed.searchParams.get("ref");
  const expiresRaw = parsed.searchParams.get("expires");
  const sig = parsed.searchParams.get("sig");
  if (!ref || !expiresRaw || !sig) {
    return null;
  }
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }
  const expected = hmac(secret, ref, expiresAtMs);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(sig);
  const signatureValid =
    expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  if (!signatureValid) {
    return null;
  }
  if (nowMs > expiresAtMs) {
    return null;
  }
  return { ref, expiresAtMs };
}
