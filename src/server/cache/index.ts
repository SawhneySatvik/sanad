/**
 * The container's own cache builder: env-driven, so a route never chooses its cache tier itself.
 * Absent Upstash config (either name pair) or under the e2e harness, memory is the only tier —
 * e2e's fake provider must never read or write the one real shared Redis instance production uses.
 */

import { isE2eMode, optionalEnv } from "@/server/core/env";
import { LayeredCache } from "./layered";
import { MemoryKeyValueCache } from "./memory";
import { cacheEnvironmentTag, NamespacedCache } from "./namespaced";
import type { KeyValueCache } from "./types";
import { UpstashRedisCache, type UpstashConfig } from "./upstash";

export type { KeyValueCache } from "./types";
export { MemoryKeyValueCache } from "./memory";
export { LayeredCache } from "./layered";
export { NamespacedCache, cacheEnvironmentTag } from "./namespaced";
export { UpstashRedisCache, type UpstashConfig } from "./upstash";

// Vercel's own Upstash marketplace integration injects KV_REST_API_*; UPSTASH_REDIS_REST_* is the
// name Upstash's own dashboard and most other integrations use. Each pair must be complete on its
// own — never a URL from one and a token from the other.
function resolveUpstashConfig(): UpstashConfig | undefined {
  const kvUrl = optionalEnv("KV_REST_API_URL");
  const kvToken = optionalEnv("KV_REST_API_TOKEN");
  if (kvUrl !== undefined && kvToken !== undefined) return { url: kvUrl, token: kvToken };
  const upstashUrl = optionalEnv("UPSTASH_REDIS_REST_URL");
  const upstashToken = optionalEnv("UPSTASH_REDIS_REST_TOKEN");
  if (upstashUrl !== undefined && upstashToken !== undefined) return { url: upstashUrl, token: upstashToken };
  return undefined;
}

/** The production/dev cache: memory only with no Upstash config or under e2e; layered and namespaced otherwise. */
export function createCacheFromEnv(): KeyValueCache {
  if (isE2eMode()) return new MemoryKeyValueCache();
  const config = resolveUpstashConfig();
  if (config === undefined) return new MemoryKeyValueCache();
  const layered = new LayeredCache(new MemoryKeyValueCache(), new UpstashRedisCache(config));
  return new NamespacedCache(layered, cacheEnvironmentTag());
}
