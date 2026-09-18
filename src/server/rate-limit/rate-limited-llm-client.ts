/**
 * createRateLimitedLlmClient — builds a request's LLM client from the two provider sides the
 * container supplies, flattened into one FallbackLlmClient wrapped in withCallerLimit. A tier's
 * own rate-limit key is `LlmTier.rateLimitKey` when set, else its side's key; an unrecognized key
 * fails at construction. A tier's circuit breaker is checked before its bucket is charged, so a
 * skipped tier costs no quota. The principal and the client IP are charged once per call — never
 * wrap the result in withCallerLimit or charge them again.
 */

import type { Db } from "@/db/client";
import { ConfigError } from "@/server/core/env";
import type { Principal } from "@/server/core/types";
import { FallbackLlmClient, tiersOf, type LlmTier } from "@/server/llm/fallback";
import type { LlmClient } from "@/server/llm/types";
import { UNKNOWN_CLIENT_IP } from "./client-ip";
import { DEFAULT_GLOBAL_LIMIT, type Clock, type ProviderKey } from "./limiter";
import { withCallerLimit } from "./with-caller-limit";
import { withGlobalLimit } from "./with-global-limit";

/** Options for createRateLimitedLlmClient — see this file's header for the composition it builds. */
export interface CreateRateLimitedLlmClientOptions {
  db: Db;
  primary: LlmClient;
  secondary: LlmClient;
  primaryProvider: ProviderKey;
  secondaryProvider: ProviderKey;
  // Overrides the resolved limit for any tier that counts against its own side's key (an untagged
  // tier, or one tagged with the side's own key); same precedence as withGlobalLimit's own `limit`
  // (explicit > env var > built-in default). A tier tagged with a different key is unaffected.
  primaryLimit?: number;
  secondaryLimit?: number;
  principal: Principal;
  // Unset means UNKNOWN_CLIENT_IP: a caller that can't name the IP shares the one conservative bucket.
  clientIp?: string;
  principalLimit?: number;
  ipLlmLimit?: number;
  principalDailyLimit?: number;
  ipLlmDailyLimit?: number;
  clock?: Clock;
}

// `undefined` means "use the side's own key"; a string must be a recognized ProviderKey — anything
// else is a tagging typo in providers.ts that would otherwise silently conflate two quotas.
function resolveProviderKey(rateLimitKey: string | undefined, sideProvider: ProviderKey): ProviderKey {
  if (rateLimitKey === undefined) return sideProvider;
  if (!Object.hasOwn(DEFAULT_GLOBAL_LIMIT, rateLimitKey)) {
    const err = new ConfigError(rateLimitKey);
    err.message = `LlmTier.rateLimitKey ${JSON.stringify(rateLimitKey)} is not a recognized ProviderKey.`;
    throw err;
  }
  return rateLimitKey as ProviderKey;
}

/** Builds one request's rate-limited LLM client — see this file's header for the composition order. */
export function createRateLimitedLlmClient(opts: CreateRateLimitedLlmClientOptions): LlmClient {
  const limited = (side: LlmClient, sideProvider: ProviderKey, sideLimit: number | undefined): LlmTier[] =>
    tiersOf(side).map((tier) => {
      const providerKey = resolveProviderKey(tier.rateLimitKey, sideProvider);
      const limit = providerKey === sideProvider ? sideLimit : undefined;
      return { ...tier, client: withGlobalLimit(tier.client, { db: opts.db, providerKey, limit, clock: opts.clock }) };
    });
  const [first, ...rest] = [
    ...limited(opts.primary, opts.primaryProvider, opts.primaryLimit),
    ...limited(opts.secondary, opts.secondaryProvider, opts.secondaryLimit),
  ];
  return withCallerLimit(new FallbackLlmClient(first, ...rest), {
    db: opts.db,
    principal: opts.principal,
    clientIp: opts.clientIp ?? UNKNOWN_CLIENT_IP,
    limits: {
      principalPerMinute: opts.principalLimit,
      ipPerMinute: opts.ipLlmLimit,
      principalPerDay: opts.principalDailyLimit,
      ipPerDay: opts.ipLlmDailyLimit,
    },
    clock: opts.clock,
  });
}
