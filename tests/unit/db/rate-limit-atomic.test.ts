import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";

// M2 gate: the atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING increment never loses or
// double-counts under concurrent callers. PGlite is single-connection, so the 20 "concurrent" calls
// interleave rather than race — the control test below shows that alone exposes a lost update.

const N = 20;
const WINDOW = "2026-09-23T10:00";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

// Verbatim the pattern in docs/SCHEMA.md "Rate limits and the result cache".
async function incrementPrincipal(principalKey: string): Promise<number> {
  const result = await t.client.query<{ request_count: number }>(
    `INSERT INTO rate_limit_buckets (principal_key, window_key, request_count, updated_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (principal_key, window_key)
     DO UPDATE SET request_count = rate_limit_buckets.request_count + 1, updated_at = now()
     RETURNING request_count`,
    [principalKey, WINDOW],
  );
  return result.rows[0].request_count;
}

// The same pattern through the typed drizzle builder, as repositories will write it.
async function incrementIp(ipKey: string): Promise<number> {
  const [row] = await t.db
    .insert(s.ipRateLimitBuckets)
    .values({ ipKey, windowKey: WINDOW, requestCount: 1 })
    .onConflictDoUpdate({
      target: [s.ipRateLimitBuckets.ipKey, s.ipRateLimitBuckets.windowKey],
      set: { requestCount: sql`${s.ipRateLimitBuckets.requestCount} + 1`, updatedAt: sql`now()` },
    })
    .returning({ requestCount: s.ipRateLimitBuckets.requestCount });
  return row.requestCount;
}

async function incrementProvider(providerKey: string): Promise<number> {
  const [row] = await t.db
    .insert(s.globalLlmRateLimit)
    .values({ providerKey, windowKey: WINDOW, requestCount: 1 })
    .onConflictDoUpdate({
      target: [s.globalLlmRateLimit.providerKey, s.globalLlmRateLimit.windowKey],
      set: { requestCount: sql`${s.globalLlmRateLimit.requestCount} + 1`, updatedAt: sql`now()` },
    })
    .returning({ requestCount: s.globalLlmRateLimit.requestCount });
  return row.requestCount;
}

const oneToN = Array.from({ length: N }, (_, i) => i + 1);

describe("atomic rate-limit increments (20 concurrent callers, one key)", () => {
  it("rate_limit_buckets: final count is exactly 20 and every caller saw a distinct count 1..20", async () => {
    const returned = await Promise.all(Array.from({ length: N }, () => incrementPrincipal("guest:abc")));
    expect([...returned].sort((a, b) => a - b)).toEqual(oneToN);
    const [row] = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(and(eq(s.rateLimitBuckets.principalKey, "guest:abc"), eq(s.rateLimitBuckets.windowKey, WINDOW)));
    expect(row.requestCount).toBe(N);
  });

  it("ip_rate_limit_buckets: final count is exactly 20", async () => {
    const returned = await Promise.all(Array.from({ length: N }, () => incrementIp("iphash-1")));
    expect([...returned].sort((a, b) => a - b)).toEqual(oneToN);
    const rows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(rows).toHaveLength(1);
    expect(rows[0].requestCount).toBe(N);
  });

  it("global_llm_rate_limit: final count is exactly 20", async () => {
    const returned = await Promise.all(Array.from({ length: N }, () => incrementProvider("gemini")));
    expect([...returned].sort((a, b) => a - b)).toEqual(oneToN);
    const rows = await t.db.select().from(s.globalLlmRateLimit);
    expect(rows).toHaveLength(1);
    expect(rows[0].requestCount).toBe(N);
  });

  it("keys are independent: concurrent increments on two principals do not bleed into each other", async () => {
    await Promise.all([
      ...Array.from({ length: N }, () => incrementPrincipal("guest:one")),
      ...Array.from({ length: 5 }, () => incrementPrincipal("guest:two")),
    ]);
    const rows = await t.db.select().from(s.rateLimitBuckets).orderBy(s.rateLimitBuckets.principalKey);
    expect(rows.map((r) => [r.principalKey, r.requestCount])).toEqual([
      ["guest:one", N],
      ["guest:two", 5],
    ]);
  });

  it("control: the forbidden read-then-write pattern DOES lose updates under the same load (proves this harness can fail)", async () => {
    async function readThenWrite(principalKey: string): Promise<void> {
      const current = await t.client.query<{ request_count: number }>(
        "SELECT request_count FROM rate_limit_buckets WHERE principal_key = $1 AND window_key = $2",
        [principalKey, WINDOW],
      );
      const next = (current.rows[0]?.request_count ?? 0) + 1;
      await t.client.query(
        `INSERT INTO rate_limit_buckets (principal_key, window_key, request_count) VALUES ($1, $2, $3)
         ON CONFLICT (principal_key, window_key) DO UPDATE SET request_count = EXCLUDED.request_count`,
        [principalKey, WINDOW, next],
      );
    }
    await Promise.all(Array.from({ length: N }, () => readThenWrite("guest:racy")));
    const [row] = await t.db.select().from(s.rateLimitBuckets).where(eq(s.rateLimitBuckets.principalKey, "guest:racy"));
    expect(row.requestCount).toBeLessThan(N);
  });
});
