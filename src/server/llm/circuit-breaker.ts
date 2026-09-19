/**
 * A per-tier circuit breaker for FallbackLlmClient. After `failureThreshold` consecutive provider
 * failures, or immediately on a 429 that names a per-day quota or states a retry delay, the tier is
 * skipped for an open window sized from that signal (or the base window, on plain counting). Once
 * the window has passed, exactly one trial call goes through (half-open): success resets the window
 * to the base; failure doubles it, capped, unless a fresh quota signal sets a longer floor. State is
 * in memory, per server instance: a breaker is built once with its client and shared by every request.
 */

import type { AppError } from "@/server/core/errors";
import { getProviderStatus, isPerDayQuotaError } from "./errors";

/** Three in a row: one live Gemini call in five has failed in transit and then answered on the next attempt. */
export const FAILURE_THRESHOLD = 3;
/** Long enough that a hung gateway costs at most one trial call a minute, short enough to recover within a minute. */
export const OPEN_MS = 60_000;
/** Longest a tier is ever skipped, however long backoff doubling or a provider's stated delay runs. */
export const MAX_OPEN_MS = 600_000;

/** Whether a call may go through, and the error that opened the breaker when it may not. */
export type BreakerGate = { allowed: true } | { allowed: false; lastError: AppError };

// Logged with llm_circuit_open, never the provider's own message: threshold (consecutive-failure
// count), provider_retry_delay/per_day_quota (a 429's own stated recovery time), backoff (a
// half-open trial failed with no fresh quota signal, so the previous window doubled).
type OpenReason = "threshold" | "provider_retry_delay" | "per_day_quota" | "backoff";

type State =
  | { kind: "closed"; consecutiveFailures: number }
  | { kind: "open"; since: number; lastError: AppError; trialInFlight: boolean; windowMs: number };

/** Overrides for CircuitBreaker's defaults; `now` is a test seam for a fake clock. */
export interface CircuitBreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  maxOpenMs?: number;
  now?: () => number;
}

/** One breaker per provider tier; see the module header for its state transitions. */
export class CircuitBreaker {
  private state: State = { kind: "closed", consecutiveFailures: 0 };
  private readonly failureThreshold: number;
  private readonly baseOpenMs: number;
  private readonly maxOpenMs: number;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? FAILURE_THRESHOLD;
    this.baseOpenMs = options.openMs ?? OPEN_MS;
    this.maxOpenMs = options.maxOpenMs ?? MAX_OPEN_MS;
    this.now = options.now ?? Date.now;
  }

  // Call only right before calling the tier: when it grants the half-open trial, that trial is taken.
  // A refusal carries the error that opened the breaker, so a skipped tier still reports a real cause.
  acquire(): BreakerGate {
    if (this.state.kind === "closed") return { allowed: true };
    if (this.state.trialInFlight || this.now() - this.state.since < this.state.windowMs) {
      return { allowed: false, lastError: this.state.lastError };
    }
    this.state.trialInFlight = true;
    return { allowed: true };
  }

  // Whether acquire() would let a call through now, without taking the trial.
  isAvailable(): boolean {
    return this.state.kind === "closed" || (!this.state.trialInFlight && this.now() - this.state.since >= this.state.windowMs);
  }

  // Milliseconds until acquire() would grant a trial; 0 once it would, or if the breaker is closed.
  // Used to size a retry-after hint when every tier in a chain is skipped and none is ever called.
  remainingOpenMs(): number {
    return this.state.kind === "open" ? Math.max(0, this.state.windowMs - (this.now() - this.state.since)) : 0;
  }

  recordSuccess(): void {
    this.state = { kind: "closed", consecutiveFailures: 0 };
  }

  recordFailure(error: AppError): void {
    const quota = quotaWindowFor(error, this.baseOpenMs, this.maxOpenMs);
    if (this.state.kind === "open") {
      // Doubles only while a trial is in flight. A slow call that started before the tier opened can
      // still land here once acquire() has granted a later trial, misattributed to that trial — but a
      // failure at that moment is still fresh evidence the tier is down, and this can double the
      // window at most once per open period (the next open() call resets `since`).
      if (!this.state.trialInFlight) return;
      // A fresh quota signal is a floor on the next window, never a reason to shrink the doubled
      // backoff already in progress.
      const doubled = Math.min(this.state.windowMs * 2, this.maxOpenMs);
      const windowMs = quota ? Math.max(doubled, quota.windowMs) : doubled;
      this.open(windowMs, error, quota && quota.windowMs > doubled ? quota.reason : "backoff", undefined);
      return;
    }
    if (quota) {
      this.open(quota.windowMs, error, quota.reason, this.state.consecutiveFailures + 1);
      return;
    }
    const consecutiveFailures = this.state.consecutiveFailures + 1;
    if (consecutiveFailures < this.failureThreshold) {
      this.state = { kind: "closed", consecutiveFailures };
      return;
    }
    this.open(this.baseOpenMs, error, "threshold", consecutiveFailures);
  }

  // The call ended without saying anything about the tier's health (the provider rejected the request,
  // the answer failed the schema, our own rate limit refused it, the caller cancelled): free the trial
  // and change nothing else.
  release(): void {
    if (this.state.kind === "open") this.state.trialInFlight = false;
  }

  private open(windowMs: number, error: AppError, reason: OpenReason, consecutiveFailures: number | undefined): void {
    this.state = { kind: "open", since: this.now(), lastError: error, trialInFlight: false, windowMs };
    console.warn(
      JSON.stringify({ event: "llm_circuit_open", tier: this.name, openMs: windowMs, reason, consecutiveFailures, code: error.code }),
    );
  }
}

type QuotaOpen = { windowMs: number; reason: "provider_retry_delay" | "per_day_quota" };

// A 429's own stated recovery time, when it is worth opening immediately rather than waiting for
// failureThreshold. A per-day quota is checked first: it can carry a short RetryInfo delay too, but
// only the daily reset actually clears it, so it always gets the max window regardless of any delay.
function quotaWindowFor(error: AppError, baseOpenMs: number, maxOpenMs: number): QuotaOpen | undefined {
  if (getProviderStatus(error) !== 429) return undefined;
  if (isPerDayQuotaError(error)) return { windowMs: maxOpenMs, reason: "per_day_quota" };
  if (error.retryAfterSeconds !== undefined) {
    return { windowMs: Math.min(Math.max(baseOpenMs, error.retryAfterSeconds * 1000), maxOpenMs), reason: "provider_retry_delay" };
  }
  return undefined;
}
