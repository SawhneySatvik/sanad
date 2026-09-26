/**
 * Conditional-GET support for the handful of responses that are immutable once access is granted.
 * A route's `cache()` is only ever invoked on run()'s own successful result — after the same
 * principal-scoped repository read every other response goes through has already thrown for a
 * missing or foreign id — so an ETag here is only ever handed out post-authorization, never before
 * it, and a 304 carries no more information than the 200 it stands in for. Every conditional
 * response also carries `Vary: Cookie`: the session cookie is what makes two callers' authorization
 * outcomes for the same URL differ, so a shared cache must never serve one caller's answer to another.
 */

export interface ConditionalCache {
  etag: string;
  cacheControl: string;
}

// Weak (`W/"..."`) and strong tags compare equal here: this app has no case where the weak/strong
// distinction itself matters, and a client that stored a weak tag must still be able to 304 with it.
function unwrap(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

/** Whether `header` (a comma-separated If-None-Match list, or "*") matches `etag`. */
export function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const value = header.trim();
  if (value === "*") return true;
  const target = unwrap(etag);
  return value.split(",").some((candidate) => unwrap(candidate) === target);
}
