/**
 * Combines a caller-supplied AbortSignal with a per-attempt timeout into the single signal every
 * transport call is given. Shared by gemini.ts and gemma.ts, so both adapters treat "abort or
 * timeout" the same way.
 */
export function combineTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}
