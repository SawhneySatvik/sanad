/**
 * The one `{time}` formatter behind the canonical error-copy table's retry sentences: "45 seconds"
 * or "3 minutes" — never a raw number, never a decimal, and always the singular for exactly 1.
 */
export function formatRetryTime(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  if (whole < 60) return whole === 1 ? "1 second" : `${whole} seconds`;
  const minutes = Math.max(1, Math.round(whole / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
