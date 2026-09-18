/**
 * Client-IP extraction and canonicalization. Without this, 203.0.113.9 / ::ffff:203.0.113.9 / an
 * IPv6 address whose interface identifier rotates per request (RFC 4941 privacy extensions,
 * common in practice) would each land in a different rate-limit bucket, defeating the IP-keyed
 * backstop for exactly the caller sophisticated enough to trigger it.
 */

import { isIP } from "node:net";
import { optionalEnv } from "@/server/core/env";

// Deliberately not a syntactically valid IP: every unparseable/missing client IP collapses into
// this one shared bucket rather than hashing raw garbage into a unique bucket that would bypass
// the IP tier for anyone who can make their IP unparseable — fail-closed and conservative.
/** Shared bucket key for any request whose client IP could not be extracted or parsed. */
export const UNKNOWN_CLIENT_IP = "unknown-client";

/** A canonicalized client IP, or the reason extraction/parsing failed. */
export type NormalizedIpResult = { ok: true; value: string } | { ok: false; reason: "invalid" | "missing" };

/**
 * Canonicalizes a client IP so equivalent representations of the same client collapse to the same
 * rate-limit bucket key: IPv4 to canonical dotted-quad; IPv4-mapped IPv6 to that same dotted-quad;
 * any other IPv6 fully expanded with its interface identifier zeroed to a /64 prefix, so a client
 * whose identifier rotates per request still lands in the same bucket. Idempotent. A holder of a
 * whole /48 still gets 65,536 buckets; only the global per-provider tier bounds that client.
 */
export function normalizeIp(raw: string): NormalizedIpResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "missing" };

  const version = isIP(trimmed);

  if (version === 4) {
    return { ok: true, value: canonicalV4(trimmed) };
  }

  if (version === 6) {
    const groups = expandIPv6(trimmed);
    if (!groups) return { ok: false, reason: "invalid" };

    // IPv4-mapped IPv6 (RFC 4291): the first 80 bits are zero, the next 16 are all-ones.
    if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
      return { ok: true, value: hexGroupsToV4(groups[6], groups[7]) };
    }

    const networkPrefix = [...groups.slice(0, 4), "0000", "0000", "0000", "0000"];
    return { ok: true, value: networkPrefix.join(":") };
  }

  return { ok: false, reason: "invalid" };
}

function canonicalV4(addr: string): string {
  return addr
    .split(".")
    .map((octet) => Number(octet))
    .join(".");
}

function hexGroupsToV4(hi: string, lo: string): string {
  const a = parseInt(hi, 16);
  const b = parseInt(lo, 16);
  return [(a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff].join(".");
}

// Hand-rolled since node:net exposes only isIP() (booleans/version, no canonicalizer). Returns 8
// lowercase, zero-padded 4-hex-digit groups, or null if `raw` isn't syntactically expandable.
function expandIPv6(raw: string): string[] | null {
  let addr = raw.toLowerCase();

  // An embedded IPv4 dotted-quad tail converts to two hex groups before the rest of the expansion runs.
  const lastColonIndex = addr.lastIndexOf(":");
  const tail = lastColonIndex >= 0 ? addr.slice(lastColonIndex + 1) : addr;
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const octets = tail.split(".").map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16).padStart(4, "0");
    const lo = ((octets[2] << 8) | octets[3]).toString(16).padStart(4, "0");
    addr = `${addr.slice(0, lastColonIndex + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null; // more than one "::" is never valid

  let allGroups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tailGroups = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - (head.length + tailGroups.length);
    if (missing < 0) return null;
    allGroups = [...head, ...Array(missing).fill("0"), ...tailGroups];
  } else {
    allGroups = addr.split(":");
  }

  if (allGroups.length !== 8) return null;
  if (!allGroups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;

  return allGroups.map((g) => g.padStart(4, "0"));
}

/** The minimal header-reading surface clientIpFromHeaders needs (a real Headers object satisfies it). */
export interface HeaderSource {
  get(name: string): string | null;
}

const TRUSTED_PROXY_HOPS_VAR = "TRUSTED_PROXY_HOPS";
let warnedInvalidHops = false;

// How many reverse proxies you run in front of the app, or undefined when none is declared. Anything
// but a plain positive integer counts as undeclared: a typo must never start trusting a header.
function trustedProxyHops(): number | undefined {
  const raw = optionalEnv(TRUSTED_PROXY_HOPS_VAR);
  if (raw === undefined) return undefined;
  if (/^[1-9]\d*$/.test(raw.trim())) return Number(raw.trim());
  if (!warnedInvalidHops) {
    warnedInvalidHops = true;
    // Naming the bad value is safe: a hop count, never a secret.
    console.warn(`${TRUSTED_PROXY_HOPS_VAR} is not a positive integer (got ${JSON.stringify(raw)}) — X-Forwarded-For is not trusted.`);
  }
  return undefined;
}

/**
 * The only sanctioned way to read a client IP; a route must never read `x-forwarded-for` directly.
 * Any header a client can set itself would let it pick a fresh rate-limit bucket per request, so:
 * - on Vercel (`VERCEL` set), only `x-vercel-forwarded-for`, which the platform sets itself;
 * - elsewhere, only `x-forwarded-for`, and only when `TRUSTED_PROXY_HOPS` declares how many
 *   reverse proxies sit in front of the app. Each proxy appends the address it received from, so the
 *   client is that many entries from the right; everything left of it is client-supplied.
 * Anything else — including `x-vercel-forwarded-for` off Vercel — is ignored.
 * @returns `{ ok: false }` when no trusted header is present; pass `UNKNOWN_CLIENT_IP` to the rate limiter, never the raw header value.
 */
export function clientIpFromHeaders(headers: HeaderSource): NormalizedIpResult {
  if (optionalEnv("VERCEL") !== undefined) {
    const vercelForwarded = headers.get("x-vercel-forwarded-for");
    if (vercelForwarded === null || vercelForwarded.trim() === "") return { ok: false, reason: "missing" };
    return normalizeIp(vercelForwarded.split(",")[0]);
  }

  const hops = trustedProxyHops();
  const forwarded = headers.get("x-forwarded-for");
  if (hops === undefined || forwarded === null) return { ok: false, reason: "missing" };
  const entries = forwarded.split(",");
  // Fewer entries than proxies: the request didn't come through all of them.
  if (entries.length < hops) return { ok: false, reason: "missing" };
  return normalizeIp(entries[entries.length - hops]);
}
