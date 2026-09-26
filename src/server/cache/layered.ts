/**
 * L1 (memory, per server instance) in front of L2 (Redis, shared): read L1 first, then L2 on an L1
 * miss, backfilling L1 so a burst of identical reads on this instance stops hitting the network.
 * L1's backfill TTL is deliberately short and fixed, not the entry's real remaining TTL — Upstash's
 * GET doesn't return one, and a stale L1 copy would otherwise outlive a write that shortens or
 * clears the same key in Redis. Writes go to both tiers, always.
 */

import type { KeyValueCache } from "./types";

// Short relative to every real TTL this app uses (analysis: up to 7 days, general chat: 24h) — L1
// exists only to dedupe repeated reads within a small window, never to be the source of freshness.
export const DEFAULT_L1_BACKFILL_TTL_SECONDS = 60;

export class LayeredCache implements KeyValueCache {
  constructor(
    private readonly l1: KeyValueCache,
    private readonly l2: KeyValueCache,
    private readonly l1BackfillTtlSeconds: number = DEFAULT_L1_BACKFILL_TTL_SECONDS,
  ) {}

  async get(key: string): Promise<string | null> {
    const l1Hit = await this.l1.get(key);
    if (l1Hit !== null) return l1Hit;
    const l2Hit = await this.l2.get(key);
    if (l2Hit !== null) await this.l1.set(key, l2Hit, this.l1BackfillTtlSeconds);
    return l2Hit;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await Promise.all([this.l1.set(key, value, Math.min(ttlSeconds, this.l1BackfillTtlSeconds)), this.l2.set(key, value, ttlSeconds)]);
  }
}
