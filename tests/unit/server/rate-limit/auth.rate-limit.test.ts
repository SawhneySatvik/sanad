// The sign-in/sign-up-specific buckets (limiter.ts's checkAuthIp*/checkAuthEmail*/enforceAuthRateLimits):
// their own atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING counters, independent of the
// generic per-IP/per-principal tiers every route pays. Real PGlite throughout — never mocked.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import { AppError } from "@/server/core/errors";
import { hashAuthEmail, hashIp } from "@/server/rate-limit/ip-hash";
import {
  checkAuthEmailHourlyLimit,
  checkAuthEmailLimit,
  checkAuthIpHourlyLimit,
  checkAuthIpLimit,
  DEFAULT_AUTH_EMAIL_PER_HOUR,
  DEFAULT_AUTH_EMAIL_PER_MINUTE,
  DEFAULT_AUTH_IP_PER_HOUR,
  DEFAULT_AUTH_IP_PER_MINUTE,
  enforceAuthEmailLimit,
  enforceAuthIpLimit,
  enforceAuthRateLimits,
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

describe("checkAuthIpLimit / enforceAuthIpLimit — per-minute", () => {
  it("defaults to 5/min and rejects the 6th attempt from one IP, across distinct emails", async () => {
    const clock = fixedClock("2026-09-23T10:00:30.000Z");
    const ip = "203.0.113.10";
    for (let i = 0; i < DEFAULT_AUTH_IP_PER_MINUTE; i++) {
      const result = await checkAuthIpLimit(t.db, ip, { clock });
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(DEFAULT_AUTH_IP_PER_MINUTE);
    }
    const sixth = await checkAuthIpLimit(t.db, ip, { clock });
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    await expect(enforceAuthIpLimit(t.db, ip, { clock })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("RATE_LIMIT_AUTH_IP_PER_MINUTE overrides the default", async () => {
    vi.stubEnv("RATE_LIMIT_AUTH_IP_PER_MINUTE", "2");
    const result = await checkAuthIpLimit(t.db, "203.0.113.11");
    expect(result.limit).toBe(2);
  });

  it("is independent of the generic per-request IP tier — its own key prefix, own row", async () => {
    const clock = fixedClock("2026-09-23T10:00:30.000Z");
    await checkAuthIpLimit(t.db, "203.0.113.12", { clock });
    const rows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(rows.map((r) => r.ipKey)).toEqual([expect.stringMatching(/^authip:/)]);
  });
});

describe("checkAuthIpHourlyLimit — per-hour, across fresh minutes", () => {
  it("defaults to 20/hour and rejects the 21st attempt, minute windows notwithstanding", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < DEFAULT_AUTH_IP_PER_HOUR; i++) {
      // A fresh minute each time (still the same UTC hour) — proves the hourly bucket doesn't reset
      // just because the per-minute window rolled over.
      const clock = fixedClock(`2026-09-23T10:${String(i % 60).padStart(2, "0")}:00.000Z`);
      const result = await checkAuthIpHourlyLimit(t.db, ip, { clock });
      expect(result.allowed).toBe(true);
    }
    const twentyFirst = await checkAuthIpHourlyLimit(t.db, ip, { clock: fixedClock("2026-09-23T10:59:00.000Z") });
    expect(twentyFirst.allowed).toBe(false);
    expect(twentyFirst.limit).toBe(DEFAULT_AUTH_IP_PER_HOUR);
  });

  it("RATE_LIMIT_AUTH_IP_PER_HOUR overrides the default", async () => {
    vi.stubEnv("RATE_LIMIT_AUTH_IP_PER_HOUR", "3");
    const result = await checkAuthIpHourlyLimit(t.db, "203.0.113.21");
    expect(result.limit).toBe(3);
  });
});

describe("checkAuthEmailLimit / enforceAuthEmailLimit — per-minute, keyed by hash", () => {
  it("defaults to 5/min and rejects the 6th attempt against one email, across distinct IPs", async () => {
    const clock = fixedClock("2026-09-23T11:00:30.000Z");
    const email = "asha@example.com";
    for (let i = 0; i < DEFAULT_AUTH_EMAIL_PER_MINUTE; i++) {
      const result = await checkAuthEmailLimit(t.db, email, { clock });
      expect(result.allowed).toBe(true);
    }
    const sixth = await checkAuthEmailLimit(t.db, email, { clock });
    expect(sixth.allowed).toBe(false);
    await expect(enforceAuthEmailLimit(t.db, email, { clock })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("is case-insensitive: Asha@Example.com and asha@example.com share one bucket", async () => {
    const clock = fixedClock("2026-09-23T11:05:00.000Z");
    await checkAuthEmailLimit(t.db, "Asha@Example.com", { clock });
    const second = await checkAuthEmailLimit(t.db, "asha@example.com", { clock });
    expect(second.count).toBe(2);
  });

  it("never stores the raw email — every principal_key row this test wrote is a hash, not an address", async () => {
    await checkAuthEmailLimit(t.db, "raw-email-guard@example.com");
    const rows = await t.db.select().from(s.rateLimitBuckets);
    for (const row of rows) expect(row.principalKey).not.toContain("@");
    expect(rows.some((r) => r.principalKey === `authemail:${hashAuthEmail("raw-email-guard@example.com")}`)).toBe(true);
  });

  it("RATE_LIMIT_AUTH_EMAIL_PER_MINUTE overrides the default", async () => {
    vi.stubEnv("RATE_LIMIT_AUTH_EMAIL_PER_MINUTE", "2");
    const result = await checkAuthEmailLimit(t.db, "override@example.com");
    expect(result.limit).toBe(2);
  });
});

describe("checkAuthEmailHourlyLimit — per-hour", () => {
  it("defaults to 20/hour", async () => {
    const result = await checkAuthEmailHourlyLimit(t.db, "hourly@example.com");
    expect(result.limit).toBe(DEFAULT_AUTH_EMAIL_PER_HOUR);
  });

  it("RATE_LIMIT_AUTH_EMAIL_PER_HOUR overrides the default", async () => {
    vi.stubEnv("RATE_LIMIT_AUTH_EMAIL_PER_HOUR", "9");
    const result = await checkAuthEmailHourlyLimit(t.db, "hourly-override@example.com");
    expect(result.limit).toBe(9);
  });
});

describe("enforceAuthRateLimits — composed IP-then-email enforcement", () => {
  it("rejects once the IP bucket trips, before ever charging the email bucket", async () => {
    const clock = fixedClock("2026-09-23T12:00:00.000Z");
    const ip = "203.0.113.30";
    for (let i = 0; i < DEFAULT_AUTH_IP_PER_MINUTE; i++) {
      await enforceAuthRateLimits(t.db, ip, `distinct-${i}@example.com`, { clock });
    }
    await expect(enforceAuthRateLimits(t.db, ip, "never-charged@example.com", { clock })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const emailRows = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(eq(s.rateLimitBuckets.principalKey, `authemail:${hashAuthEmail("never-charged@example.com")}`));
    expect(emailRows).toHaveLength(0);
  });

  it("rejects on the email bucket once the IP bucket is clear but the email one isn't", async () => {
    const clock = fixedClock("2026-09-23T12:05:00.000Z");
    const email = "shared-target@example.com";
    for (let i = 0; i < DEFAULT_AUTH_EMAIL_PER_MINUTE; i++) {
      await enforceAuthRateLimits(t.db, `203.0.113.4${i}`, email, { clock });
    }
    await expect(enforceAuthRateLimits(t.db, "203.0.113.49", email, { clock })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("overrides pass through to all four buckets", async () => {
    const clock = fixedClock("2026-09-23T12:10:00.000Z");
    const ip = "203.0.113.50";
    const email = "overrides@example.com";
    await enforceAuthRateLimits(t.db, ip, email, { ipPerMinute: 1, clock });
    await expect(enforceAuthRateLimits(t.db, ip, "another@example.com", { ipPerMinute: 1, clock })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe("concurrency race — atomic increments under concurrent callers", () => {
  it("12 concurrent sign-in attempts, same IP and email, limit 5: exactly 5 fulfil, 7 reject with RATE_LIMITED and a positive Retry-After", async () => {
    const clock = fixedClock("2026-09-23T10:00:30.000Z");
    const ip = "203.0.113.60";
    const email = "racer@example.com";

    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => enforceAuthRateLimits(t.db, ip, email, { ipPerMinute: 5, clock })),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(AppError);
      expect((reason as AppError).code).toBe("RATE_LIMITED");
      expect((reason as AppError).retryAfterSeconds).toBeGreaterThan(0);
    }

    // Every attempt increments the IP-minute bucket (allowed or not — rejecting is a post-hoc
    // decision on an already-atomic count), but only the 5 that passed the IP gate ever reach
    // (and increment) the email bucket behind it.
    const [ipRow] = await t.db.select().from(s.ipRateLimitBuckets).where(eq(s.ipRateLimitBuckets.ipKey, `authip:${hashIp(ip)}`));
    expect(ipRow.requestCount).toBe(12);

    const [emailRow] = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(eq(s.rateLimitBuckets.principalKey, `authemail:${hashAuthEmail(email)}`));
    expect(emailRow.requestCount).toBe(5);
  });
});
