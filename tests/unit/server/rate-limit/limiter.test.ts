import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import { AppError } from "@/server/core/errors";
import { ConfigError } from "@/server/core/env";
import type { Principal } from "@/server/core/types";
import { hashIp } from "@/server/rate-limit/ip-hash";
import {
  checkGlobalLimit,
  checkIpLimit,
  checkIpLlmDailyLimit,
  checkIpLlmLimit,
  checkPrincipalDailyLimit,
  checkPrincipalLimit,
  DEFAULT_GLOBAL_LIMIT,
  DEFAULT_IP_DAILY_LIMIT,
  DEFAULT_IP_LIMIT,
  DEFAULT_IP_LLM_LIMIT,
  DEFAULT_PRINCIPAL_DAILY_LIMIT,
  DEFAULT_PRINCIPAL_LIMIT,
  enforceGlobalLimit,
  enforceIpLimit,
  enforceIpLlmDailyLimit,
  enforcePrincipalDailyLimit,
  enforcePrincipalLimit,
  MAX_HTTP_ATTEMPTS_PER_CALL,
  principalKeyFor,
  pruneRateLimitBuckets,
  PRUNE_INTERVAL_MS,
  type Clock,
} from "@/server/rate-limit/limiter";

vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "a".repeat(32));

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
  vi.unstubAllEnvs();
  vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "a".repeat(32));
});

function fixedClock(iso: string): Clock {
  const date = new Date(iso);
  return { now: () => date };
}

function guest(id: string): Principal {
  return { type: "guest", guestSessionId: id };
}

describe("checkPrincipalLimit / enforcePrincipalLimit — 50 concurrent callers, limit 10", () => {
  it("50 concurrent callers against a limit of 10: allows EXACTLY 10 and rejects EXACTLY 40 with RATE_LIMITED", async () => {
    const clock = fixedClock("2026-09-23T10:00:30.000Z");
    const principal = guest("racer");

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () => enforcePrincipalLimit(t.db, principal, { limit: 10, clock })),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(AppError);
      expect((reason as AppError).code).toBe("RATE_LIMITED");
      expect((reason as AppError).retryAfterSeconds).toBeGreaterThan(0);
    }

    // The persisted row itself reflects every attempt (allowed AND rejected both increment —
    // rejecting is a post-hoc decision on an already-atomic count, not a second read).
    const [row] = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(eq(s.rateLimitBuckets.principalKey, principalKeyFor(principal)));
    expect(row.requestCount).toBe(50);
  });

  it("checkPrincipalLimit (non-throwing) reports the same exact 10/40 split", async () => {
    const clock = fixedClock("2026-09-23T11:00:00.000Z");
    const principal = guest("racer-2");

    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkPrincipalLimit(t.db, principal, { limit: 10, clock })),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(40);
  });
});

// A guest principal_key is self-issued and droppable (a script sheds its cookie for a fresh quota);
// the IP-keyed bucket is the backstop since it doesn't depend on the caller's self-reported identity
// at all.
describe("checkIpLimit / enforceIpLimit — cookie-cycling backstop", () => {
  it("30 requests, each with a DIFFERENT guest principal but the SAME IP: the principal tier alone is defeated (all 30 pass), but the IP tier catches it (exactly 10 pass)", async () => {
    const clock = fixedClock("2026-09-23T12:00:00.000Z");
    const ip = "203.0.113.9";

    // Positive control proving the vulnerability this test closes: 30 DIFFERENT guest principals
    // each get their own fresh principal-tier bucket, so the principal limiter alone lets all 30
    // through even at the same limit=10 a single principal would be capped at.
    const principalOutcomes = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => enforcePrincipalLimit(t.db, guest(`cycled-${i}`), { limit: 10, clock })),
    );
    expect(principalOutcomes.filter((o) => o.status === "fulfilled")).toHaveLength(30);

    // Same 30 requests, but through the IP tier (same IP every time, since a cookie-cycling
    // script can change its principal but not its network origin) -> capped at exactly 10.
    const ipOutcomes = await Promise.allSettled(
      Array.from({ length: 30 }, () => enforceIpLimit(t.db, ip, { limit: 10, clock })),
    );

    const fulfilled = ipOutcomes.filter((o) => o.status === "fulfilled");
    const rejected = ipOutcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(20);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect(((r as PromiseRejectedResult).reason as AppError).code).toBe("RATE_LIMITED");
    }
  });

  it("the raw IP never appears in the stored ip_key, which is stable for the same IP", async () => {
    const clock = fixedClock("2026-09-23T13:00:00.000Z");
    const ip = "198.51.100.23";

    await checkIpLimit(t.db, ip, { limit: 100, clock });
    await checkIpLimit(t.db, ip, { limit: 100, clock });

    const rows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(rows).toHaveLength(1); // same IP -> same key -> one bucket row, not two
    expect(rows[0].ipKey).not.toBe(ip);
    expect(rows[0].ipKey).not.toContain(ip);
    expect(rows[0].ipKey).toBe(hashIp(ip)); // stable, matches the module's own hash function
    expect(rows[0].requestCount).toBe(2);
  });

  // Without normalization these variants would land in distinct buckets, defeating the IP backstop
  // for a proxy that sometimes reports v4, sometimes v4-mapped-v6. Pure normalizeIp coverage lives
  // in client-ip.test.ts; this asserts the same collapsing happens end to end through checkIpLimit.
  it("v4 and its IPv4-mapped-v6 form collapse into ONE bucket end to end through checkIpLimit", async () => {
    const clock = fixedClock("2026-09-23T13:30:00.000Z");
    await checkIpLimit(t.db, "203.0.113.9", { limit: 100, clock });
    await checkIpLimit(t.db, "::ffff:203.0.113.9", { limit: 100, clock });

    const rows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(rows).toHaveLength(1);
    expect(rows[0].requestCount).toBe(2);
  });

  it("two v6 addresses in the same /64 collapse into ONE bucket; a different /64 gets its own", async () => {
    const clock = fixedClock("2026-09-23T13:31:00.000Z");
    await checkIpLimit(t.db, "2001:db8::1", { limit: 100, clock });
    await checkIpLimit(t.db, "2001:DB8:0:0:0:0:0:1", { limit: 100, clock }); // same /64, verbose spelling
    await checkIpLimit(t.db, "2001:db8:0:1::1", { limit: 100, clock }); // different /64

    const rows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(rows).toHaveLength(2);
    const counts = rows.map((r) => r.requestCount).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2]);
  });

  it("an unparseable IP falls back to the ONE shared UNKNOWN_CLIENT_IP bucket, never a unique per-garbage-string bucket", async () => {
    const clock = fixedClock("2026-09-23T13:32:00.000Z");
    await checkIpLimit(t.db, "not-an-ip", { limit: 100, clock });
    await checkIpLimit(t.db, "also-not-an-ip", { limit: 100, clock });
    await checkIpLimit(t.db, "", { limit: 100, clock });

    const rows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(rows).toHaveLength(1); // all three garbage inputs share the same bucket
    expect(rows[0].requestCount).toBe(3);
  });
});

describe("checkIpLlmLimit — the per-IP LLM-call bucket", () => {
  it("is a separate bucket from the per-request IP bucket: one IP charged on both gets two hashed rows, neither holding the raw IP", async () => {
    const clock = fixedClock("2026-09-23T13:40:00.000Z");
    const ip = "198.51.100.23";

    await checkIpLimit(t.db, ip, { limit: 100, clock });
    const call = await checkIpLlmLimit(t.db, ip, { limit: 100, clock });

    expect(call.count).toBe(1); // not 2: the per-request charge landed elsewhere
    const rows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(rows.map((r) => r.ipKey).sort()).toEqual([hashIp(ip), `llm:${hashIp(ip)}`].sort());
    for (const row of rows) expect(row.ipKey).not.toContain(ip);
  });

  it("normalizes like the per-request tier: v4, v4-mapped v6 and garbage-vs-garbage each collapse to one bucket", async () => {
    const clock = fixedClock("2026-09-23T13:41:00.000Z");
    await checkIpLlmLimit(t.db, "203.0.113.9", { limit: 100, clock });
    const mapped = await checkIpLlmLimit(t.db, "::ffff:203.0.113.9", { limit: 100, clock });
    await checkIpLlmLimit(t.db, "not-an-ip", { limit: 100, clock });
    const garbage = await checkIpLlmLimit(t.db, "", { limit: 100, clock });

    expect([mapped.count, garbage.count]).toEqual([2, 2]);
  });
});

// Daily windows are UTC days; their retry-after points at the next UTC midnight.
describe("daily LLM-call caps — atomic, per UTC day", () => {
  it("50 concurrent calls against a principal daily cap of 10: EXACTLY 10 allowed, the row holds all 50", async () => {
    const clock = fixedClock("2026-09-23T10:00:30.000Z");
    const principal = guest("daily-racer");

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () => enforcePrincipalDailyLimit(t.db, principal, { limit: 10, clock })),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(10);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(40);
    const [row] = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(eq(s.rateLimitBuckets.principalKey, `day:${principalKeyFor(principal)}`));
    expect(row).toMatchObject({ windowKey: "2026-09-23", requestCount: 50 });
  });

  it("50 concurrent calls against an IP daily cap of 10: EXACTLY 10 allowed, the row holds all 50", async () => {
    const clock = fixedClock("2026-09-23T10:00:30.000Z");
    const ip = "203.0.113.200";

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () => enforceIpLlmDailyLimit(t.db, ip, { limit: 10, clock })),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(10);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected).toHaveLength(40);
    for (const r of rejected) expect((r.reason as AppError).code).toBe("RATE_LIMITED");
    const [row] = await t.db.select().from(s.ipRateLimitBuckets).where(eq(s.ipRateLimitBuckets.ipKey, `llm-day:${hashIp(ip)}`));
    expect(row).toMatchObject({ windowKey: "2026-09-23", requestCount: 50 });
  });

  it("the daily principal row is never mistaken for the per-minute one", async () => {
    const clock = fixedClock("2026-09-23T10:00:30.000Z");
    const principal = guest("daily-separate");
    await checkPrincipalLimit(t.db, principal, { limit: 100, clock });
    const daily = await checkPrincipalDailyLimit(t.db, principal, { limit: 100, clock });

    expect(daily.count).toBe(1);
    const [minuteRow] = await t.db.select().from(s.rateLimitBuckets).where(eq(s.rateLimitBuckets.principalKey, principalKeyFor(principal)));
    expect(minuteRow).toMatchObject({ windowKey: "2026-09-23T10:00", requestCount: 1 });
  });

  it("counts across every minute of one UTC day, and resets at UTC midnight", async () => {
    const principal = guest("daily-rollover");
    const at = (iso: string) => checkPrincipalDailyLimit(t.db, principal, { limit: 2, clock: fixedClock(iso) });

    expect((await at("2026-09-23T00:00:00.000Z")).allowed).toBe(true);
    expect((await at("2026-09-23T12:34:00.000Z")).allowed).toBe(true);
    expect((await at("2026-09-23T23:59:59.000Z")).allowed).toBe(false);
    const nextDay = await at("2026-09-24T00:00:00.000Z");
    expect(nextDay).toMatchObject({ allowed: true, count: 1 });
  });

  it.each([
    ["2026-09-23T23:59:30.000Z", 30],
    ["2026-09-23T10:00:00.000Z", 14 * 3600],
    ["2026-09-23T00:00:00.500Z", 24 * 3600],
  ])("over the daily cap at %s: RATE_LIMITED with retryAfterSeconds = %i, the next UTC midnight", async (iso, seconds) => {
    const clock = fixedClock(iso);
    await checkIpLlmDailyLimit(t.db, "203.0.113.201", { limit: 1, clock });

    let caught: unknown;
    try {
      await enforceIpLlmDailyLimit(t.db, "203.0.113.201", { limit: 1, clock });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: seconds });
  });
});

describe("checkGlobalLimit / enforceGlobalLimit — shared per-provider quota", () => {
  it("keys are independent per provider: none of the four bleed into each other", async () => {
    const clock = fixedClock("2026-09-23T14:00:00.000Z");
    const gemini = await checkGlobalLimit(t.db, "gemini", { limit: 10, clock });
    const geminiFallback = await checkGlobalLimit(t.db, "gemini_fallback", { limit: 10, clock });
    const gemma = await checkGlobalLimit(t.db, "gemma", { limit: 10, clock });
    const gemmaGoogle = await checkGlobalLimit(t.db, "gemma_google", { limit: 10, clock });
    expect(gemini.count).toBe(1);
    expect(geminiFallback.count).toBe(1);
    expect(gemma.count).toBe(1);
    expect(gemmaGoogle.count).toBe(1);
  });

  it("over the limit, enforceGlobalLimit throws RATE_LIMITED with a positive retryAfterSeconds", async () => {
    const clock = fixedClock("2026-09-23T15:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock });
    let caught: unknown;
    try {
      await enforceGlobalLimit(t.db, "gemini", { limit: 1, clock });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("RATE_LIMITED");
    expect((caught as AppError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it.each(["gemini_fallback", "gemma_google"] as const)(
    "%s: 50 concurrent callers, limit 10 — EXACTLY 10 admitted and 40 rejected, no bleed to another key",
    async (providerKey) => {
      const clock = fixedClock("2026-09-23T15:30:00.000Z");

      const outcomes = await Promise.allSettled(
        Array.from({ length: 50 }, () => enforceGlobalLimit(t.db, providerKey, { limit: 10, clock })),
      );

      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(10);
      expect(rejected).toHaveLength(40);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
        expect(((r as PromiseRejectedResult).reason as AppError).code).toBe("RATE_LIMITED");
      }

      const rows = await t.db.select().from(s.globalLlmRateLimit);
      expect(rows).toHaveLength(1); // only the one key's row exists — nothing else was touched
      expect(rows[0].providerKey).toBe(providerKey);
      expect(rows[0].requestCount).toBe(50);
    },
  );
});

describe("fixed-window rollover", () => {
  it("a new minute window resets the count, even at the same limit", async () => {
    const principal = guest("rollover");
    const windowOne = fixedClock("2026-09-23T16:00:59.000Z");
    const windowTwo = fixedClock("2026-09-23T16:01:00.000Z");

    for (let i = 0; i < 10; i++) {
      const r = await checkPrincipalLimit(t.db, principal, { limit: 10, clock: windowOne });
      expect(r.allowed).toBe(true);
    }
    const eleventh = await checkPrincipalLimit(t.db, principal, { limit: 10, clock: windowOne });
    expect(eleventh.allowed).toBe(false);

    // Same principal, same limit, but the clock has crossed a minute boundary -> fresh bucket.
    const firstOfNextWindow = await checkPrincipalLimit(t.db, principal, { limit: 10, clock: windowTwo });
    expect(firstOfNextWindow.allowed).toBe(true);
    expect(firstOfNextWindow.count).toBe(1);

    const rows = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(eq(s.rateLimitBuckets.principalKey, principalKeyFor(principal)));
    expect(rows).toHaveLength(2); // two distinct window rows for the same principal
  });

  // Fixed-window counters have a well-known boundary-burst property: firing requests exactly across
  // a window edge can momentarily admit close to 2x the nominal limit within a ~1-second span. This
  // demonstrates it rather than just asserting it. Not a bug — accepted at this project's scale.
  it("documents the fixed-window boundary-burst property: EXACTLY 10 admitted within ~100ms across a boundary, against a nominal limit of 5/minute", async () => {
    const principal = guest("burst");
    const endOfWindowOne = fixedClock("2026-09-23T17:00:59.900Z");
    const startOfWindowTwo = fixedClock("2026-09-23T17:01:00.000Z");

    const windowOneResults = [];
    for (let i = 0; i < 5; i++) {
      windowOneResults.push(await checkPrincipalLimit(t.db, principal, { limit: 5, clock: endOfWindowOne }));
    }
    expect(windowOneResults.every((r) => r.allowed)).toBe(true);

    const windowTwoResults = [];
    for (let i = 0; i < 5; i++) {
      windowTwoResults.push(await checkPrincipalLimit(t.db, principal, { limit: 5, clock: startOfWindowTwo }));
    }
    expect(windowTwoResults.every((r) => r.allowed)).toBe(true);

    // Both windows independently allow up to 5 -> 10 requests admitted within ~100ms of wall time,
    // against a nominal limit of 5/minute. This is the accepted trade-off, not a regression.
    const totalAdmitted = [...windowOneResults, ...windowTwoResults].filter((r) => r.allowed).length;
    expect(totalAdmitted).toBe(10);
  });
});

describe("pruneRateLimitBuckets — local dev cleanup (mirrors the M4 pg_cron job's updated_at contract)", () => {
  it("deletes rows older than the cutoff and leaves newer rows (and a same-key row within the window) untouched", async () => {
    // The atomic increment (./limiter.ts) writes `updated_at` via the DB's own `now()`, verbatim
    // per docs/SCHEMA.md's atomic-increment SQL — it does NOT take the injectable Clock (that
    // only governs `window_key`). So to exercise prune's cutoff against an "old" row without
    // waiting real wall-clock time, backdate `updated_at` directly with raw SQL after inserting —
    // this is the DB-level equivalent of "this row was last touched 3 hours ago".
    const stalePrincipal = guest("stale");
    await checkPrincipalLimit(t.db, stalePrincipal, { limit: 1000 });
    await checkIpLimit(t.db, "203.0.113.55", { limit: 1000 });
    await checkGlobalLimit(t.db, "gemini", { limit: 1000 });

    // Positive control: a row inside the retention window must survive the prune.
    const freshPrincipal = guest("fresh");
    await checkPrincipalLimit(t.db, freshPrincipal, { limit: 1000 });

    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
    await t.client.query("UPDATE rate_limit_buckets SET updated_at = $1 WHERE principal_key = $2", [
      longAgo,
      principalKeyFor(stalePrincipal),
    ]);
    await t.client.query("UPDATE ip_rate_limit_buckets SET updated_at = $1", [longAgo]);
    await t.client.query("UPDATE global_llm_rate_limit SET updated_at = $1 WHERE provider_key = $2", [longAgo, "gemini"]);

    const result = await pruneRateLimitBuckets(t.db, 60); // older than 60 minutes ago, real clock

    expect(result).toEqual({ principal: 1, ip: 1, global: 1 });

    const survivors = await t.db.select().from(s.rateLimitBuckets);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].principalKey).toBe(principalKeyFor(freshPrincipal));
  });
});

// The per-request IP check prunes stale rows on its own, throttled per process by wall-clock time.
describe("opportunistic pruning on the per-request IP check", () => {
  const HOUR_MS = 60 * 60 * 1000;

  async function backdate(table: string, hoursAgo: number): Promise<void> {
    await t.client.query(`UPDATE ${table} SET updated_at = $1`, [new Date(Date.now() - hoursAgo * HOUR_MS).toISOString()]);
  }

  async function rowCounts(): Promise<number[]> {
    return [
      (await t.db.select().from(s.rateLimitBuckets)).length,
      (await t.db.select().from(s.globalLlmRateLimit)).length,
    ];
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prunes rows untouched for over 2 days, keeps a daily row touched 23 hours ago, then waits PRUNE_INTERVAL_MS before pruning again", async () => {
    vi.resetModules();
    const fresh = await import("@/server/rate-limit/limiter");
    let nowMs = Date.now();
    await fresh.checkGlobalLimit(t.db, "gemini", { limit: 100 });
    await fresh.checkPrincipalDailyLimit(t.db, guest("daily-survivor"), { limit: 100 });
    await backdate("global_llm_rate_limit", 49);
    await backdate("rate_limit_buckets", 23);
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    await fresh.checkIpLimit(t.db, "203.0.113.60", { limit: 100 }); // this process's first check: prunes

    // The stale global row is gone; the daily row a prune must not reset survived.
    expect(await rowCounts()).toEqual([1, 0]);

    await fresh.checkGlobalLimit(t.db, "gemini", { limit: 100 });
    await backdate("global_llm_rate_limit", 49);
    nowMs += PRUNE_INTERVAL_MS - 1;
    await fresh.checkIpLimit(t.db, "203.0.113.60", { limit: 100 });
    expect(await rowCounts()).toEqual([1, 1]); // throttled: not pruned yet

    nowMs += 1;
    await fresh.checkIpLimit(t.db, "203.0.113.60", { limit: 100 });
    expect(await rowCounts()).toEqual([1, 0]);
  });

  it("an injected test clock never moves the cutoff: a clock years ahead prunes nothing fresh", async () => {
    vi.resetModules();
    const fresh = await import("@/server/rate-limit/limiter");
    const farFuture = fixedClock("2031-01-01T00:00:00.000Z");
    await fresh.checkPrincipalLimit(t.db, guest("fresh-row"), { limit: 100, clock: farFuture });

    await fresh.checkIpLimit(t.db, "203.0.113.61", { limit: 100, clock: farFuture }); // prunes, by wall-clock time

    expect(await rowCounts()).toEqual([1, 0]);
  });
});

describe("principalKeyFor", () => {
  it("formats a user principal as user:<id>", () => {
    expect(principalKeyFor({ type: "user", userId: "u1" })).toBe("user:u1");
  });

  it("formats a guest principal as guest:<id>", () => {
    expect(principalKeyFor({ type: "guest", guestSessionId: "g1" })).toBe("guest:g1");
  });
});

describe("default limits and env-var overrides", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "a".repeat(32));
  });

  it("uses the built-in default when no override and no env var is set", async () => {
    const result = await checkPrincipalLimit(t.db, guest("defaults-1"));
    expect(result.limit).toBe(DEFAULT_PRINCIPAL_LIMIT);
  });

  it("uses the built-in IP default when no override and no env var is set", async () => {
    const result = await checkIpLimit(t.db, "203.0.113.99");
    expect(result.limit).toBe(DEFAULT_IP_LIMIT);
  });

  it("uses the built-in per-provider global default when no override and no env var is set", async () => {
    const gemini = await checkGlobalLimit(t.db, "gemini");
    const geminiFallback = await checkGlobalLimit(t.db, "gemini_fallback");
    const gemma = await checkGlobalLimit(t.db, "gemma");
    const gemmaGoogle = await checkGlobalLimit(t.db, "gemma_google");
    expect(gemini.limit).toBe(DEFAULT_GLOBAL_LIMIT.gemini);
    expect(geminiFallback.limit).toBe(DEFAULT_GLOBAL_LIMIT.gemini_fallback);
    expect(gemma.limit).toBe(DEFAULT_GLOBAL_LIMIT.gemma);
    expect(gemmaGoogle.limit).toBe(DEFAULT_GLOBAL_LIMIT.gemma_google);
  });

  it("RATE_LIMIT_PRINCIPAL_PER_MINUTE overrides the default: a limit of 2 rejects the 3rd call", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "2");
    const principal = guest("env-override");
    const clock = fixedClock("2026-09-23T18:00:00.000Z");

    const first = await checkPrincipalLimit(t.db, principal, { clock }); // no opts.limit -> reads env
    const second = await checkPrincipalLimit(t.db, principal, { clock });
    const third = await checkPrincipalLimit(t.db, principal, { clock });

    expect(first.limit).toBe(2);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
  });

  it("an explicit opts.limit takes precedence over the env var", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "2");
    const result = await checkPrincipalLimit(t.db, guest("explicit-wins"), { limit: 99 });
    expect(result.limit).toBe(99);
  });

  it("an invalid env var value (non-numeric) silently falls back to the built-in default", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "abc");
    const result = await checkPrincipalLimit(t.db, guest("invalid-nonnumeric"));
    expect(result.limit).toBe(DEFAULT_PRINCIPAL_LIMIT);
  });

  it("an invalid env var value (zero) silently falls back to the built-in default", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "0");
    const result = await checkPrincipalLimit(t.db, guest("invalid-zero"));
    expect(result.limit).toBe(DEFAULT_PRINCIPAL_LIMIT);
  });

  it("uses the built-in per-IP LLM-call and daily defaults when no override and no env var is set", async () => {
    const principal = guest("defaults-daily");
    expect((await checkIpLlmLimit(t.db, "203.0.113.98")).limit).toBe(DEFAULT_IP_LLM_LIMIT);
    expect((await checkPrincipalDailyLimit(t.db, principal)).limit).toBe(DEFAULT_PRINCIPAL_DAILY_LIMIT);
    expect((await checkIpLlmDailyLimit(t.db, "203.0.113.98")).limit).toBe(DEFAULT_IP_DAILY_LIMIT);
  });

  it("RATE_LIMIT_IP_LLM_PER_MINUTE, RATE_LIMIT_PRINCIPAL_PER_DAY and RATE_LIMIT_IP_LLM_PER_DAY each override only their own tier", async () => {
    vi.stubEnv("RATE_LIMIT_IP_LLM_PER_MINUTE", "7");
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_DAY", "40");
    vi.stubEnv("RATE_LIMIT_IP_LLM_PER_DAY", "80");
    const ip = "203.0.113.97";

    expect((await checkIpLlmLimit(t.db, ip)).limit).toBe(7);
    expect((await checkPrincipalDailyLimit(t.db, guest("env-daily"))).limit).toBe(40);
    expect((await checkIpLlmDailyLimit(t.db, ip)).limit).toBe(80);
    expect((await checkIpLimit(t.db, ip)).limit).toBe(DEFAULT_IP_LIMIT); // the per-request tier is untouched
    expect((await checkPrincipalLimit(t.db, guest("env-daily"))).limit).toBe(DEFAULT_PRINCIPAL_LIMIT);
  });

  it("a bad daily env value falls back to the built-in default; opts.limit is validated before the increment", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_DAY", "1e9");
    const principal = guest("bad-daily");
    expect((await checkPrincipalDailyLimit(t.db, principal)).limit).toBe(DEFAULT_PRINCIPAL_DAILY_LIMIT);

    await expect(checkIpLlmDailyLimit(t.db, "203.0.113.96", { limit: 0 })).rejects.toBeInstanceOf(ConfigError);
    const ipRows = await t.db.select().from(s.ipRateLimitBuckets).where(eq(s.ipRateLimitBuckets.ipKey, `llm-day:${hashIp("203.0.113.96")}`));
    expect(ipRows).toHaveLength(0);
  });

  it("RATE_LIMIT_GEMINI_PER_MINUTE and RATE_LIMIT_GEMMA_PER_MINUTE override independently", async () => {
    vi.stubEnv("RATE_LIMIT_GEMINI_PER_MINUTE", "3");
    const gemini = await checkGlobalLimit(t.db, "gemini");
    const gemma = await checkGlobalLimit(t.db, "gemma");
    expect(gemini.limit).toBe(3);
    expect(gemma.limit).toBe(DEFAULT_GLOBAL_LIMIT.gemma); // untouched by the gemini-only override
  });

  it("RATE_LIMIT_GEMINI_FALLBACK_PER_MINUTE and RATE_LIMIT_GEMMA_GOOGLE_PER_MINUTE override independently of gemini/gemma", async () => {
    vi.stubEnv("RATE_LIMIT_GEMINI_FALLBACK_PER_MINUTE", "4");
    vi.stubEnv("RATE_LIMIT_GEMMA_GOOGLE_PER_MINUTE", "6");
    const gemini = await checkGlobalLimit(t.db, "gemini");
    const geminiFallback = await checkGlobalLimit(t.db, "gemini_fallback");
    const gemma = await checkGlobalLimit(t.db, "gemma");
    const gemmaGoogle = await checkGlobalLimit(t.db, "gemma_google");
    expect(geminiFallback.limit).toBe(4);
    expect(gemmaGoogle.limit).toBe(6);
    expect(gemini.limit).toBe(DEFAULT_GLOBAL_LIMIT.gemini); // untouched
    expect(gemma.limit).toBe(DEFAULT_GLOBAL_LIMIT.gemma); // untouched
  });

  // `Number("1e9")` is 1_000_000_000 and `Number("0x10")` is 16 — both are valid positive integers
  // to `Number.isInteger`, so a plain-decimal-string check is required to reject them.
  it.each(["1e9", "0x10", "007", "-5", "3.5", "12abc"])(
    "rejects the non-plain-decimal-integer env value %j, falls back to the built-in default",
    async (badValue) => {
      vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", badValue);
      const result = await checkPrincipalLimit(t.db, guest(`bad-env-${badValue}`));
      expect(result.limit).toBe(DEFAULT_PRINCIPAL_LIMIT);
    },
  );

  it("trims surrounding whitespace before validating (leading/trailing spaces are not themselves invalid)", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "  12  ");
    const result = await checkPrincipalLimit(t.db, guest("whitespace-trimmed"));
    expect(result.limit).toBe(12);
  });

  it("clamps an env value above the maximum allowed limit, rather than discarding it entirely", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "999999999");
    const result = await checkPrincipalLimit(t.db, guest("above-cap"));
    expect(result.limit).toBe(10_000); // MAX_ENV_LIMIT — clamped, not the built-in default
  });

  it("accepts a plain decimal integer at or below the cap unchanged", async () => {
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "10000");
    const result = await checkPrincipalLimit(t.db, guest("at-cap"));
    expect(result.limit).toBe(10_000);
  });

  it("warns about a bad env var AT MOST ONCE per process, even across many calls", async () => {
    vi.resetModules();
    vi.stubEnv("RATE_LIMIT_PRINCIPAL_PER_MINUTE", "1e9");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await import("@/server/rate-limit/limiter");

    await fresh.checkPrincipalLimit(t.db, guest("warn-once-1"));
    await fresh.checkPrincipalLimit(t.db, guest("warn-once-2"));
    await fresh.checkPrincipalLimit(t.db, guest("warn-once-3"));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("RATE_LIMIT_PRINCIPAL_PER_MINUTE");
    warnSpy.mockRestore();
  });

  it("opts.limit must be a finite integer >= 1 — throws a typed ConfigError otherwise (fails loud, not silently)", async () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      let caught: unknown;
      try {
        await checkPrincipalLimit(t.db, guest("bad-opts-limit"), { limit: bad });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
    }
  });

  it("opts.limit is validated BEFORE the atomic increment — a bad value never writes a bucket row", async () => {
    const principal = guest("bad-opts-limit-no-write");
    let caught: unknown;
    try {
      await checkPrincipalLimit(t.db, principal, { limit: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);

    const rows = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(eq(s.rateLimitBuckets.principalKey, principalKeyFor(principal)));
    expect(rows).toHaveLength(0);
  });

  it("opts.limit accepts a finite positive integer", async () => {
    const result = await checkPrincipalLimit(t.db, guest("good-opts-limit"), { limit: 3 });
    expect(result.limit).toBe(3);
  });
});

// Pinned so a future default change can't silently let a single principal consume a whole shared
// provider quota alone.
describe("the per-principal default sits below every global provider default", () => {
  it.each(Object.keys(DEFAULT_GLOBAL_LIMIT) as (keyof typeof DEFAULT_GLOBAL_LIMIT)[])("DEFAULT_PRINCIPAL_LIMIT < DEFAULT_GLOBAL_LIMIT.%s", (providerKey) => {
    expect(DEFAULT_PRINCIPAL_LIMIT).toBeLessThan(DEFAULT_GLOBAL_LIMIT[providerKey]);
  });
});

// Pinned so a future default change can't let one IP fill a shared bucket, or one guest or IP spend
// a free Gemini model's whole day (20 requests per model per day).
describe("the per-IP LLM-call and daily defaults", () => {
  it.each(Object.keys(DEFAULT_GLOBAL_LIMIT) as (keyof typeof DEFAULT_GLOBAL_LIMIT)[])("DEFAULT_IP_LLM_LIMIT < DEFAULT_GLOBAL_LIMIT.%s", (providerKey) => {
    expect(DEFAULT_IP_LLM_LIMIT).toBeLessThan(DEFAULT_GLOBAL_LIMIT[providerKey]);
  });

  it("an IP gets at least one principal's per-minute and daily allowance, so a lone guest hits its own cap first", () => {
    expect(DEFAULT_IP_LLM_LIMIT).toBeGreaterThanOrEqual(DEFAULT_PRINCIPAL_LIMIT);
    expect(DEFAULT_IP_DAILY_LIMIT).toBeGreaterThanOrEqual(DEFAULT_PRINCIPAL_DAILY_LIMIT);
  });

  it("one principal can't spend more than a quarter of the primary model's 500-a-day quota even if every call needs its repair retry; one IP stays under the whole day at one request per call", () => {
    expect(DEFAULT_PRINCIPAL_DAILY_LIMIT * MAX_HTTP_ATTEMPTS_PER_CALL).toBeLessThanOrEqual(125);
    expect(DEFAULT_IP_DAILY_LIMIT).toBeLessThan(500);
    expect(Number.isInteger(DEFAULT_IP_DAILY_LIMIT)).toBe(true);
  });
});
