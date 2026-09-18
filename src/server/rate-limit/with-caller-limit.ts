/**
 * Decorator charging the caller's own limits at the LLM-call boundary: the principal and the client
 * IP, each per minute and per UTC day. Charged per LLM call, never per inbound request — the
 * orchestrator's fan-out can turn one request into several calls. The IP tiers exist because a guest
 * principal is self-issued: a script that sheds its cookie gets a fresh principal bucket, never a
 * fresh IP bucket. Wrap the LlmClient once, at the outermost layer, via the one blessed composition
 * factory — never again on its output, and never nested inside a fallback client, whose
 * retry-on-429 behavior would charge the caller once per tier.
 */

import type { ZodType } from "zod";
import type { Db } from "@/db/client";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { toStreamErrorEvent } from "@/server/llm/errors";
import type {
  LlmCapabilities,
  LlmClient,
  LlmCompleteInput,
  LlmCompleteResult,
  LlmStreamEvent,
} from "@/server/llm/types";
import {
  assertValidLimitOverride,
  enforceIpLlmDailyLimit,
  enforceIpLlmLimit,
  enforcePrincipalDailyLimit,
  enforcePrincipalLimit,
  type Clock,
} from "./limiter";

/** Limit overrides for the caller's tiers; unset means the env var or limiter.ts's default. */
export interface CallerLimits {
  principalPerMinute?: number;
  ipPerMinute?: number;
  principalPerDay?: number;
  ipPerDay?: number;
}

/** Options for withCallerLimit: whose buckets to charge, and overrides for tests. */
export interface WithCallerLimitOptions {
  db: Db;
  principal: Principal;
  // Raw or normalized; the limiter normalizes it, and anything unparseable shares one bucket.
  clientIp: string;
  limits?: CallerLimits;
  clock?: Clock;
}

/**
 * Charges one LLM call against the caller's four tiers, throwing RATE_LIMITED at the first one over
 * its limit. What withCallerLimit charges before every call; also for a result served in place of a
 * call (understand's analysis cache), which must cost the caller exactly what the call would.
 * Minute tiers before daily ones, so a call throttled for the minute never spends daily budget; the
 * principal's minute before the IP's, so a caller over its own per-minute limit never charges the IP
 * its neighbours share. A caller over its daily cap has already charged the IP's minute. Each check
 * increments even when it rejects — the atomic count is the decision.
 */
export async function chargeCallerLimits(opts: WithCallerLimitOptions): Promise<void> {
  const { db, principal, clientIp, clock } = opts;
  const limits = opts.limits ?? {};
  await enforcePrincipalLimit(db, principal, { limit: limits.principalPerMinute, clock });
  await enforceIpLlmLimit(db, clientIp, { limit: limits.ipPerMinute, clock });
  await enforcePrincipalDailyLimit(db, principal, { limit: limits.principalPerDay, clock });
  await enforceIpLlmDailyLimit(db, clientIp, { limit: limits.ipPerDay, clock });
}

class CallerLimitedLlmClient implements LlmClient {
  readonly capabilities: LlmCapabilities;

  constructor(
    private readonly inner: LlmClient,
    private readonly opts: WithCallerLimitOptions,
  ) {
    // Fixed option names, never the principal or IP — neither may end up in a thrown ConfigError's message.
    const limits = opts.limits ?? {};
    assertValidLimitOverride("withCallerLimit.opts.limits.principalPerMinute", limits.principalPerMinute);
    assertValidLimitOverride("withCallerLimit.opts.limits.ipPerMinute", limits.ipPerMinute);
    assertValidLimitOverride("withCallerLimit.opts.limits.principalPerDay", limits.principalPerDay);
    assertValidLimitOverride("withCallerLimit.opts.limits.ipPerDay", limits.ipPerDay);
    this.capabilities = inner.capabilities;
  }

  private enforce(): Promise<void> {
    return chargeCallerLimits(this.opts);
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    await this.enforce();
    return this.inner.complete(input);
  }

  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    try {
      await this.enforce();
    } catch (error) {
      if (error instanceof AppError && error.code === "RATE_LIMITED") {
        yield toStreamErrorEvent(error);
        return;
      }
      throw error;
    }
    yield* this.inner.stream(input);
  }
}

/** Wraps `inner` with the caller's per-principal and per-IP limits, per minute and per UTC day. */
export function withCallerLimit(inner: LlmClient, opts: WithCallerLimitOptions): LlmClient {
  return new CallerLimitedLlmClient(inner, opts);
}
