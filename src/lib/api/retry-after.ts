/**
 * RFC 7231's Retry-After header is either delta-seconds ("120") or an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT") — never assume the numeric form. A non-positive or unparseable
 * result reads as "no usable retry time," the same as a missing header, so the canonical copy falls
 * back to its vague phrasing rather than showing "in 0 seconds" or "in -12 seconds."
 */
export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;

  const deltaSeconds = Number(value);
  if (Number.isFinite(deltaSeconds)) return deltaSeconds > 0 ? deltaSeconds : undefined;

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaMs = dateMs - Date.now();
  return deltaMs > 0 ? Math.round(deltaMs / 1000) : undefined;
}
