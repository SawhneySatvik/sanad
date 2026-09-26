/**
 * A bounded, per-instance LRU with per-entry TTL: the L1 tier in front of Redis, and the only tier
 * in dev/tests (no Upstash env vars). Map preserves insertion order, so "re-insert on touch" is
 * enough to track recency without a separate linked list — the first key iterated is always the
 * least recently used one.
 */

import type { KeyValueCache } from "./types";

interface Entry {
  value: string;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;

export class MemoryKeyValueCache implements KeyValueCache {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    // Touch: move to the end so the least recently used entry is always the first evicted.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}
