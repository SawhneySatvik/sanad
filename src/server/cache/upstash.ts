/**
 * Upstash Redis over its REST API — fetch only, no client library. Every command races a hard
 * timeout: a body that never resolves (a stalled connection, a provider outage) must not hang the
 * request it's meant to speed up, so the timeout is a Promise.race over the whole fetch+parse, not
 * just an AbortSignal a slow body could ignore. Never throws into a caller: get() resolves null and
 * set() resolves (doing nothing) on any failure, including the timeout itself.
 */

import type { KeyValueCache } from "./types";

export interface UpstashConfig {
  url: string;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 250;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// Metadata only: which Redis command, how long it took, whether it succeeded, and (on failure) the
// error's constructor name. Never the key, the value, or the bearer token — those would be user
// data or a secret in the logs.
function logCommandOutcome(op: string, durationMs: number, ok: boolean, errorClass?: string): void {
  console.warn(JSON.stringify({ event: "cache_op", surface: "upstash", op, durationMs, ok, ...(errorClass ? { errorClass } : {}) }));
}

export class UpstashRedisCache implements KeyValueCache {
  constructor(
    private readonly config: UpstashConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async get(key: string): Promise<string | null> {
    const result = await this.command("GET", ["GET", key]);
    return typeof result === "string" ? result : null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.command("SET", ["SET", key, value, "EX", String(Math.max(1, Math.round(ttlSeconds)))]);
  }

  // undefined on any failure (including a timeout); the Upstash REST envelope's own `result`
  // (possibly null, meaning a genuine cache miss) otherwise.
  private async command(op: string, body: readonly string[]): Promise<unknown> {
    const start = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const attempt = this.send(body, controller.signal);
    // A rejection that arrives after the timeout has already settled the race would otherwise be
    // an unhandled rejection — this doesn't change what the race itself sees.
    attempt.catch(() => {});
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve("timeout");
      }, this.timeoutMs);
    });
    try {
      const outcome = await Promise.race([attempt, timeout]);
      if (outcome === "timeout" || timedOut) {
        logCommandOutcome(op, Date.now() - start, false, "timeout");
        return undefined;
      }
      logCommandOutcome(op, Date.now() - start, true);
      return outcome;
    } catch (error) {
      logCommandOutcome(op, Date.now() - start, false, error instanceof Error ? error.constructor.name : "unknown");
      return undefined;
    }
  }

  private async send(body: readonly string[], signal: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(this.config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`upstash http ${res.status}`);
    const json = (await res.json()) as { result?: unknown };
    return json.result ?? null;
  }
}
