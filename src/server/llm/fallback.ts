/**
 * FallbackLlmClient: one LLM call answered by an ordered chain of provider tiers. The primary falls through
 * only on a retryable error (timeout, 5xx, 429, no response, or its own full rate-limit bucket) — a 4xx or
 * a failed schema means the request itself is wrong. A fallback tier falls through on any failure. While a
 * later tier could still run, a tier may spend at most TIER_BUDGET_SHARE of the whole budget; the last
 * runnable tier gets the rest. No fallback tier or retry starts with less than MIN_FALLBACK_BUDGET_MS
 * left. `modelUsed` names the tier that answered; `surfaced()` picks the error, and `asFinalError()` is
 * the one place that error becomes what the caller actually sees (a provider's own 429 forced to
 * UPSTREAM_UNAVAILABLE, and a chain-exhaustion retry-after).
 */

import type { ZodType } from "zod";
import { AppError, safeMessageFor } from "@/server/core/errors";
import type { BreakerGate, CircuitBreaker } from "./circuit-breaker";
import { isProviderFailure, isRetryableProviderError, isTransportFailure, streamEventError, toStreamErrorEvent } from "./errors";
import { MIN_FALLBACK_BUDGET_MS, TIER_BUDGET_SHARE } from "./timeouts";
import type {
  LlmCapabilities,
  LlmClient,
  LlmCompleteInput,
  LlmCompleteResult,
  LlmStreamErrorEvent,
  LlmStreamEvent,
} from "./types";

/** One link in a FallbackLlmClient chain. */
export interface LlmTier {
  readonly client: LlmClient;
  // Built once with the client, never per request, so it remembers failures across calls. A tier
  // whose breaker is open is skipped without being called.
  readonly breaker?: CircuitBreaker;
  // Opaque to this file: which rate-limit bucket this tier's calls count against, when it needs its
  // own quota separate from the rest of its side. Undefined means "use the side's own key" — the
  // rate-limit layer defines and resolves the actual key values.
  readonly rateLimitKey?: string;
}

type AnyInput = LlmCompleteInput<ZodType>;

const NO_BREAKER: BreakerGate = { allowed: true };

/** A single LlmClient backed by an ordered chain of provider tiers — see the module header. */
export class FallbackLlmClient implements LlmClient {
  readonly tiers: readonly LlmTier[];
  // The primary's capabilities, not the intersection: the primary serves almost all traffic, so a
  // text-only backup must not make native-document requests unroutable. Such a request skips the
  // tiers that cannot read it instead.
  readonly capabilities: LlmCapabilities;

  constructor(primary: LlmClient | LlmTier, ...fallbacks: (LlmClient | LlmTier)[]) {
    this.tiers = [primary, ...fallbacks].map((tier) => ("client" in tier ? tier : { client: tier }));
    this.capabilities = this.tiers[0].client.capabilities;
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    const budget = new ChainBudget(input.timeoutMs);
    const failures: unknown[] = [];
    for (const [index, tier] of this.tiers.entries()) {
      if (index > 0 && !mayStartFallback(input, budget)) break;
      if (index > 0 && !canRead(tier, input)) continue;
      const gate = tier.breaker?.acquire() ?? NO_BREAKER;
      if (!gate.allowed) {
        failures.push(gate.lastError);
        continue;
      }
      try {
        const result = await attempt(tier, input, budget.forTier(this.laterTierCanRun(index, input)));
        tier.breaker?.recordSuccess();
        return result;
      } catch (error) {
        settle(tier.breaker, error, input);
        if (!(error instanceof AppError) || (index === 0 && !isRetryableProviderError(error))) throw error;
        failures.push(error);
      }
    }
    const error = surfaced(failures, isProviderFailure);
    throw error instanceof AppError ? asFinalError(error, this.tiers) : error;
  }

  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    const budget = new ChainBudget(input.timeoutMs);
    const failures: LlmStreamErrorEvent[] = [];
    const isProviderSide = (event: LlmStreamErrorEvent) => isProviderFailure(streamEventError(event));
    for (const [index, tier] of this.tiers.entries()) {
      if (index > 0 && !mayStartFallback(input, budget)) break;
      if (index > 0 && !canRead(tier, input)) continue;
      const gate = tier.breaker?.acquire() ?? NO_BREAKER;
      if (!gate.allowed) {
        failures.push(toStreamErrorEvent(gate.lastError));
        continue;
      }
      const timeoutMs = budget.forTier(this.laterTierCanRun(index, input));
      const startedAt = Date.now();
      let settled = false;
      const settleWith = (error: unknown) => {
        settled = true;
        settle(tier.breaker, error, input);
      };
      let iterator = tier.client.stream({ ...input, timeoutMs })[Symbol.asyncIterator]();
      try {
        let first = await iterator.next();
        if (!first.done && first.value.type === "error" && mayRetry(streamEventError(first.value), input, timeLeft(timeoutMs, startedAt))) {
          await iterator.return?.();
          iterator = tier.client.stream({ ...input, timeoutMs: timeLeft(timeoutMs, startedAt) })[Symbol.asyncIterator]();
          first = await iterator.next();
        }

        if (!first.done && first.value.type === "error") {
          const event = first.value;
          settleWith(streamEventError(event));
          if (index === 0 && !event.retryable) {
            yield event;
            return;
          }
          failures.push(event);
          continue;
        }

        // Once this tier has emitted a token it stays on this tier: switching mid-stream would
        // splice two models' text together.
        for (let next = first; !next.done; next = await iterator.next()) {
          const event = next.value;
          if (event.type === "error") {
            settleWith(streamEventError(event));
            yield asFinalStreamError(surfaced([...failures, event], isProviderSide), this.tiers);
            return;
          }
          if (event.type === "done") {
            settled = true;
            tier.breaker?.recordSuccess();
          }
          yield event;
        }
        return;
      } finally {
        // A stream that ended without an outcome (the consumer stopped early, or the tier threw) says
        // nothing about the tier's health, but a half-open trial it held must be freed, or the tier
        // would stay skipped for good.
        if (!settled) tier.breaker?.release();
        // The consumer may stop early (a client that disconnected mid-stream); the tier's generator,
        // and the HTTP response it holds open, must still be told to clean up.
        await iterator.return?.();
      }
    }
    yield asFinalStreamError(surfaced(failures, isProviderSide), this.tiers);
  }

  // Whether any tier after `index` could take this request right now. Decides whether the tier at
  // `index` must leave time for another.
  private laterTierCanRun(index: number, input: AnyInput): boolean {
    return this.tiers.slice(index + 1).some((tier) => canRead(tier, input) && (tier.breaker?.isAvailable() ?? true));
  }
}

/** A client's tiers, for flattening several chains into one so TIER_BUDGET_SHARE isn't applied to an already-shared budget. */
export function tiersOf(client: LlmClient): readonly LlmTier[] {
  return client instanceof FallbackLlmClient ? client.tiers : [{ client }];
}

// One clock for a whole chain call.
class ChainBudget {
  private readonly startedAt = Date.now();

  constructor(private readonly totalMs: number | undefined) {}

  remaining(): number | undefined {
    return this.totalMs === undefined ? undefined : this.totalMs - (Date.now() - this.startedAt);
  }

  // What the next tier may spend: at most its share of the whole budget while a later tier could still
  // answer, otherwise everything that is left.
  forTier(laterTierCanRun: boolean): number | undefined {
    if (this.totalMs === undefined) return undefined;
    const remaining = this.totalMs - (Date.now() - this.startedAt);
    return Math.max(0, Math.floor(laterTierCanRun ? Math.min(remaining, this.totalMs * TIER_BUDGET_SHARE) : remaining));
  }
}

function mayStartFallback(input: AnyInput, budget: ChainBudget): boolean {
  // A cancelled call is not an outage: never spend another provider call on it.
  if (input.signal?.aborted) return false;
  const remaining = budget.remaining();
  return remaining === undefined || remaining >= MIN_FALLBACK_BUDGET_MS;
}

// A request carrying a native document skips any tier that cannot read one.
function canRead(tier: LlmTier, input: AnyInput): boolean {
  return !input.documents?.some((doc) => doc.nativeFile) || tier.client.capabilities.nativeDocumentInput;
}

// A call that got no HTTP response (see isTransportFailure) is retried once on the same tier,
// gated by mayRetry, before the chain falls through to the next tier.
async function attempt<Schema extends ZodType>(
  tier: LlmTier,
  input: LlmCompleteInput<Schema>,
  timeoutMs: number | undefined,
): Promise<LlmCompleteResult<Schema>> {
  const startedAt = Date.now();
  try {
    return await tier.client.complete({ ...input, timeoutMs });
  } catch (error) {
    const left = timeLeft(timeoutMs, startedAt);
    if (!mayRetry(error, input, left)) throw error;
    return await tier.client.complete({ ...input, timeoutMs: left });
  }
}

function timeLeft(timeoutMs: number | undefined, startedAt: number): number | undefined {
  return timeoutMs === undefined ? undefined : timeoutMs - (Date.now() - startedAt);
}

function mayRetry(error: unknown, input: AnyInput, left: number | undefined): boolean {
  return isTransportFailure(error) && !input.signal?.aborted && (left === undefined || left >= MIN_FALLBACK_BUDGET_MS);
}

// What one call told the tier's breaker. Only a provider failure counts against the tier: a request
// the provider rejected (4xx), an answer that failed the schema, our own rate limit and a cancelled
// call say nothing about whether the gateway is up.
function settle(breaker: CircuitBreaker | undefined, error: unknown, input: AnyInput): void {
  if (!breaker) return;
  if (error instanceof AppError && !input.signal?.aborted && isProviderFailure(error) && isRetryableProviderError(error)) {
    breaker.recordFailure(error);
  } else {
    breaker.release();
  }
}

// Every tier failed: the primary's own error surfaces unless a fallback tier failed for a reason
// that isn't also a provider outage (our own RATE_LIMITED, or SCHEMA_FAILED) — that is the real cause.
function surfaced<Failure>(failures: Failure[], isProviderSide: (failure: Failure) => boolean): Failure {
  const [primary, ...fallbacks] = failures;
  return fallbacks.find((failure) => !isProviderSide(failure)) ?? primary;
}

// The soonest any tier in the chain could actually be tried again, in ms — or undefined when that
// tells the caller nothing. settle() has already recorded this call's own outcome by the time this
// runs, so a tier this call just failed on reports its freshly-opened window too, not only tiers it
// skipped. But a single closed (healthy) breakered tier means the chain would reach that tier on the
// very next call regardless of what this failure's own tier is still blocked for — undefined in that
// case defers to the failure's own stated delay, rather than reporting some other tier's open window
// as though it were this one's floor.
function soonestRetryMs(tiers: readonly LlmTier[]): number | undefined {
  const breakers = tiers.flatMap((tier) => (tier.breaker ? [tier.breaker] : []));
  if (breakers.length === 0) return undefined;
  const soonest = Math.min(...breakers.map((breaker) => breaker.remainingOpenMs()));
  return soonest > 0 ? soonest : undefined;
}

// The one place a chain's surfaced failure becomes what the caller actually sees. Two independent
// adjustments: (1) a provider's own 429 (isProviderFailure, tagged by errors.ts's normalizeProviderError)
// is never our own limiter's RATE_LIMITED (src/server/rate-limit/**, which carries no provider status)
// — so it always becomes UPSTREAM_UNAVAILABLE, keeping its retry hint. (2) when every breakered tier in
// the chain is currently open, the retry-after is raised to the soonest any of them could answer again
// — a provider's own stated delay (say 9s) is a lower bound, never the truth once
// CircuitBreaker.quotaWindowFor has opened that same tier for longer (at least OPEN_MS): telling the
// caller to retry in 9s when every tier is still blocked for another 51s would just repeat the same
// failure.
function asFinalError(error: AppError, tiers: readonly LlmTier[]): AppError {
  const isProviderRateLimit = error.code === "RATE_LIMITED" && isProviderFailure(error);
  const soonestMs = soonestRetryMs(tiers);
  const retryAfterSeconds = soonestMs === undefined ? error.retryAfterSeconds : Math.max(error.retryAfterSeconds ?? 0, Math.ceil(soonestMs / 1000));
  if (!isProviderRateLimit && retryAfterSeconds === error.retryAfterSeconds) return error;
  return new AppError(
    isProviderRateLimit ? "UPSTREAM_UNAVAILABLE" : error.code,
    isProviderRateLimit ? safeMessageFor("UPSTREAM_UNAVAILABLE") : error.message,
    { reason: error.reason, retryAfterSeconds },
  );
}

// stream()'s own surface: recovers the real AppError a LlmStreamErrorEvent was built from (identity
// preserved through every decorator — see errors.ts's own header comment), resolves it exactly like
// asFinalError(), and rebuilds the stream event only when something actually changed.
function asFinalStreamError(event: LlmStreamErrorEvent, tiers: readonly LlmTier[]): LlmStreamErrorEvent {
  const underlying = streamEventError(event);
  if (!underlying) return event;
  const resolved = asFinalError(underlying, tiers);
  return resolved === underlying ? event : toStreamErrorEvent(resolved);
}
