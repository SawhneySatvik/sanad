/**
 * Prefixes every key with an environment tag before delegating. Local dev's `.env` and Vercel's
 * production deployment can point at the very same Upstash instance — without this, a developer
 * running `npm run dev` against real providers would read and write the exact keys a live user's
 * request does. VERCEL_ENV is Vercel's own per-deployment tag ("production"/"preview"/
 * "development"); anywhere else (local, CI) gets its own fixed tag instead, so they all share one
 * namespace distinct from every real deployment.
 */

import type { KeyValueCache } from "./types";

export function cacheEnvironmentTag(): string {
  return process.env.VERCEL_ENV ?? "local";
}

export class NamespacedCache implements KeyValueCache {
  constructor(
    private readonly inner: KeyValueCache,
    private readonly namespace: string,
  ) {}

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  get(key: string): Promise<string | null> {
    return this.inner.get(this.key(key));
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    return this.inner.set(this.key(key), value, ttlSeconds);
  }
}
