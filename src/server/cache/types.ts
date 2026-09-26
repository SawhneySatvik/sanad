/**
 * The cache port every tier (memory, Upstash, layered) implements. Values are opaque strings — a
 * caller JSON-encodes its own payload — so this module never needs to know what's cached. A cache
 * is always a way to skip re-computing something already trusted elsewhere (Postgres, an LLM
 * call); nothing here may carry a verification status (see docs/ARCHITECTURE.md's "Caching"
 * section) — that would let a cache stand in for verify() itself, which the One Guarantee forbids.
 */

export interface KeyValueCache {
  /** Null on a miss, an expired entry, or any adapter-level failure — never throws. */
  get(key: string): Promise<string | null>;
  /** A no-op on any adapter-level failure — never throws, never rejects a caller's own write. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
