import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import { ConfigError } from "@/server/core/env";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { normalizeProviderError } from "@/server/llm/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { hashIp } from "@/server/rate-limit/ip-hash";
import {
  checkIpLlmDailyLimit,
  checkIpLlmLimit,
  checkPrincipalDailyLimit,
  checkPrincipalLimit,
  principalKeyFor,
  type Clock,
} from "@/server/rate-limit/limiter";
import { withCallerLimit, type CallerLimits } from "@/server/rate-limit/with-caller-limit";

vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "a".repeat(32));

const schema = z.object({ answer: z.string() });
const call = { systemPrompt: "s", userPrompt: "u", schema };
const IP = "203.0.113.9";
const GENEROUS: CallerLimits = { principalPerMinute: 100, ipPerMinute: 100, principalPerDay: 100, ipPerDay: 100 };

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

function fixedClock(iso: string): Clock {
  const date = new Date(iso);
  return { now: () => date };
}

function guest(id: string): Principal {
  return { type: "guest", guestSessionId: id };
}

function answering(): FakeLlmClient {
  return new FakeLlmClient({ defaultResponse: { data: { answer: "ok" } } });
}

// Every counter the decorator charges, by bucket, for one principal and one IP.
async function charges(principal: Principal, ip = IP) {
  const principalRows = await t.db.select().from(s.rateLimitBuckets);
  const ipRows = await t.db.select().from(s.ipRateLimitBuckets);
  const count = (rows: { requestCount: number }[]) => rows.reduce((sum, row) => sum + row.requestCount, 0);
  return {
    principalMinute: count(principalRows.filter((r) => r.principalKey === principalKeyFor(principal))),
    principalDay: count(principalRows.filter((r) => r.principalKey === `day:${principalKeyFor(principal)}`)),
    ipMinute: count(ipRows.filter((r) => r.ipKey === `llm:${hashIp(ip)}`)),
    ipDay: count(ipRows.filter((r) => r.ipKey === `llm-day:${hashIp(ip)}`)),
  };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected a rejection");
}

describe("withCallerLimit — complete()", () => {
  it("3 sequential calls charge each of the four caller buckets 3 times; inner is called 3 times", async () => {
    const principal = guest("sequential");
    const inner = answering();
    const limited = withCallerLimit(inner, { db: t.db, principal, clientIp: IP, limits: GENEROUS, clock: fixedClock("2026-09-23T10:00:00.000Z") });

    for (let i = 0; i < 3; i++) await limited.complete(call);

    expect(inner.callCount).toBe(3);
    expect(await charges(principal)).toEqual({ principalMinute: 3, principalDay: 3, ipMinute: 3, ipDay: 3 });
  });

  it("principal over its minute limit: RATE_LIMITED with a positive retryAfterSeconds, inner never called", async () => {
    const clock = fixedClock("2026-09-23T11:00:00.000Z");
    const principal = guest("over-complete");
    await checkPrincipalLimit(t.db, principal, { limit: 1, clock });
    const inner = answering();
    const limited = withCallerLimit(inner, { db: t.db, principal, clientIp: IP, limits: { ...GENEROUS, principalPerMinute: 1 }, clock });

    const error = await rejection(limited.complete(call));

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(inner.callCount).toBe(0);
  });

  it("capabilities pass through from the inner client unchanged", () => {
    const inner = new FakeLlmClient({ capabilities: { nativeDocumentInput: true, streaming: false } });
    const limited = withCallerLimit(inner, { db: t.db, principal: guest("caps"), clientIp: IP });
    expect(limited.capabilities).toEqual(inner.capabilities);
  });
});

describe("withCallerLimit — the per-IP tier stops cookie cycling", () => {
  it("fresh principals from ONE IP: the IP's minute limit rejects the call after it, before inner", async () => {
    const clock = fixedClock("2026-09-23T12:00:00.000Z");
    const inner = answering();
    const outcomes = [];
    for (let i = 0; i < 6; i++) {
      const limited = withCallerLimit(inner, { db: t.db, principal: guest(`cycled-${i}`), clientIp: IP, limits: { ...GENEROUS, ipPerMinute: 4 }, clock });
      outcomes.push(await limited.complete(call).then(() => "ok", (error: AppError) => error.code));
    }

    expect(outcomes).toEqual(["ok", "ok", "ok", "ok", "RATE_LIMITED", "RATE_LIMITED"]);
    expect(inner.callCount).toBe(4);
  });

  it("positive control: the same fresh principals from DIFFERENT IPs are never IP-limited", async () => {
    const clock = fixedClock("2026-09-23T12:05:00.000Z");
    const inner = answering();
    for (let i = 0; i < 6; i++) {
      const limited = withCallerLimit(inner, { db: t.db, principal: guest(`spread-${i}`), clientIp: `198.51.100.${i + 1}`, limits: { ...GENEROUS, ipPerMinute: 4 }, clock });
      await limited.complete(call);
    }
    expect(inner.callCount).toBe(6);
  });

  it("two spellings of one client share the IP bucket", async () => {
    const clock = fixedClock("2026-09-23T12:10:00.000Z");
    const limits = { ...GENEROUS, ipPerMinute: 1 };
    await withCallerLimit(answering(), { db: t.db, principal: guest("v4"), clientIp: IP, limits, clock }).complete(call);

    const error = await rejection(
      withCallerLimit(answering(), { db: t.db, principal: guest("v4-mapped"), clientIp: `::ffff:${IP}`, limits, clock }).complete(call),
    );
    expect(error.code).toBe("RATE_LIMITED");
  });
});

describe("withCallerLimit — daily caps", () => {
  it("principal over its daily cap: RATE_LIMITED retryable at the next UTC midnight, though every minute window is fresh", async () => {
    const principal = guest("daily-principal");
    const inner = answering();
    const at = (iso: string) => withCallerLimit(inner, { db: t.db, principal, clientIp: IP, limits: { ...GENEROUS, principalPerDay: 2 }, clock: fixedClock(iso) });

    await at("2026-09-23T08:00:00.000Z").complete(call);
    await at("2026-09-23T14:00:00.000Z").complete(call);
    const error = await rejection(at("2026-09-23T23:59:30.000Z").complete(call));

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(30);
    expect(inner.callCount).toBe(2);
    // The next UTC day is a fresh window.
    await at("2026-09-24T00:00:00.000Z").complete(call);
    expect(inner.callCount).toBe(3);
  });

  it("IP over its daily cap: fresh principals from that IP are refused for the rest of the UTC day", async () => {
    const clock = fixedClock("2026-09-23T10:00:00.000Z");
    const inner = answering();
    const limits = { ...GENEROUS, ipPerDay: 3 };
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      const limited = withCallerLimit(inner, { db: t.db, principal: guest(`daily-cycled-${i}`), clientIp: IP, limits, clock });
      outcomes.push(await limited.complete(call).then(() => 0, (error: AppError) => error.retryAfterSeconds));
    }

    // 14 hours to 2026-09-24T00:00:00Z.
    expect(outcomes).toEqual([0, 0, 0, 14 * 3600, 14 * 3600]);
    expect(inner.callCount).toBe(3);
  });
});

describe("withCallerLimit — check order", () => {
  it("a call throttled for the minute never spends daily budget", async () => {
    const clock = fixedClock("2026-09-23T15:00:00.000Z");
    const principal = guest("minute-first");
    const limited = withCallerLimit(answering(), { db: t.db, principal, clientIp: IP, limits: { ...GENEROUS, principalPerMinute: 1 }, clock });

    await limited.complete(call);
    await rejection(limited.complete(call));
    await rejection(limited.complete(call));

    expect(await charges(principal)).toEqual({ principalMinute: 3, principalDay: 1, ipMinute: 1, ipDay: 1 });
  });

  it("a principal over its own per-minute limit never charges the IP its neighbours share", async () => {
    const clock = fixedClock("2026-09-23T15:05:00.000Z");
    const principal = guest("principal-minute-first");
    await checkPrincipalLimit(t.db, principal, { limit: 1, clock });
    const limited = withCallerLimit(answering(), { db: t.db, principal, clientIp: IP, limits: { ...GENEROUS, principalPerMinute: 1 }, clock });

    await rejection(limited.complete(call));

    expect(await charges(principal)).toEqual({ principalMinute: 2, principalDay: 0, ipMinute: 0, ipDay: 0 });
  });

  it("a principal over its daily cap has already charged the IP's minute, but never the IP's day", async () => {
    const clock = fixedClock("2026-09-23T15:06:00.000Z");
    const principal = guest("principal-day-over");
    await checkPrincipalDailyLimit(t.db, principal, { limit: 1, clock });
    const limited = withCallerLimit(answering(), { db: t.db, principal, clientIp: IP, limits: { ...GENEROUS, principalPerDay: 1 }, clock });

    await rejection(limited.complete(call));

    expect(await charges(principal)).toEqual({ principalMinute: 1, principalDay: 2, ipMinute: 1, ipDay: 0 });
  });
});

describe("withCallerLimit — stream()", () => {
  it("under every limit: inner.stream() is called, events pass through, modelUsed intact", async () => {
    const inner = new FakeLlmClient({ modelUsed: "gemini-2.0-flash", responses: [{ data: { answer: "streamed" } }] });
    const limited = withCallerLimit(inner, { db: t.db, principal: guest("stream-under"), clientIp: IP, limits: GENEROUS, clock: fixedClock("2026-09-23T16:00:00.000Z") });

    const events = [];
    for await (const event of limited.stream(call)) events.push(event);

    expect(inner.callCount).toBe(1);
    expect(events.find((e) => e.type === "done")).toMatchObject({ modelUsed: "gemini-2.0-flash", data: { answer: "streamed" } });
  });

  it.each([
    ["principal minute", (p: Principal, c: Clock) => checkPrincipalLimit(t.db, p, { limit: 1, clock: c }), { principalPerMinute: 1 }],
    ["IP minute", (_p: Principal, c: Clock) => checkIpLlmLimit(t.db, IP, { limit: 1, clock: c }), { ipPerMinute: 1 }],
    ["principal day", (p: Principal, c: Clock) => checkPrincipalDailyLimit(t.db, p, { limit: 1, clock: c }), { principalPerDay: 1 }],
    ["IP day", (_p: Principal, c: Clock) => checkIpLlmDailyLimit(t.db, IP, { limit: 1, clock: c }), { ipPerDay: 1 }],
  ] as const)("%s full: yields EXACTLY the RATE_LIMITED error event (never throws), inner never called", async (_name, fill, override) => {
    const clock = fixedClock("2026-09-23T17:00:00.000Z");
    const principal = guest("over-stream");
    await fill(principal, clock);
    const inner = answering();
    const limited = withCallerLimit(inner, { db: t.db, principal, clientIp: IP, limits: { ...GENEROUS, ...override }, clock });

    const events = [];
    for await (const event of limited.stream(call)) events.push(event);

    expect(events).toEqual([{ type: "error", code: "RATE_LIMITED", retryable: true }]);
    expect(inner.callCount).toBe(0);
  });
});

// Mirrors with-global-limit.test.ts's proof: the decorator passes inner errors/events through
// unchanged, never rewrapped.
describe("withCallerLimit — inner errors/events pass through UNCHANGED, never rewrapped", () => {
  it("complete(): a non-RATE_LIMITED error from inner propagates as the EXACT SAME error object", async () => {
    const originalError = normalizeProviderError({ status: 410 });
    const inner = new FakeLlmClient({ responses: [{ error: originalError }] });
    const limited = withCallerLimit(inner, { db: t.db, principal: guest("identity-complete"), clientIp: IP, limits: GENEROUS });

    expect(await rejection(limited.complete(call))).toBe(originalError);
  });

  it("stream(): a non-retryable inner error event (410) passes through with retryable:false preserved", async () => {
    const inner = new FakeLlmClient({ responses: [{ error: normalizeProviderError({ status: 410 }) }] });
    const limited = withCallerLimit(inner, { db: t.db, principal: guest("identity-stream"), clientIp: IP, limits: GENEROUS });

    const events = [];
    for await (const event of limited.stream(call)) events.push(event);
    expect(events).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE", retryable: false }]);
  });
});

describe("withCallerLimit — concurrent calls", () => {
  it("50 concurrent calls, principal limit 10: EXACTLY 10 admitted, 40 RATE_LIMITED, principal bucket === 50", async () => {
    const principal = guest("concurrent");
    const inner = answering();
    const limited = withCallerLimit(inner, { db: t.db, principal, clientIp: IP, limits: { ...GENEROUS, principalPerMinute: 10 }, clock: fixedClock("2026-09-23T18:00:00.000Z") });

    const outcomes = await Promise.allSettled(Array.from({ length: 50 }, () => limited.complete(call)));

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(10);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected).toHaveLength(40);
    for (const r of rejected) expect((r.reason as AppError).code).toBe("RATE_LIMITED");
    expect(inner.callCount).toBe(10);
    const [row] = await t.db.select().from(s.rateLimitBuckets).where(eq(s.rateLimitBuckets.principalKey, principalKeyFor(principal)));
    expect(row.requestCount).toBe(50);
  });

  it("50 concurrent calls from 50 fresh principals on one IP, IP daily cap 10: EXACTLY 10 admitted", async () => {
    const inner = answering();
    const clock = fixedClock("2026-09-23T18:05:00.000Z");
    const limits = { ...GENEROUS, ipPerDay: 10 };

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => withCallerLimit(inner, { db: t.db, principal: guest(`racer-${i}`), clientIp: IP, limits, clock }).complete(call)),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(10);
    expect(inner.callCount).toBe(10);
    const [row] = await t.db.select().from(s.ipRateLimitBuckets).where(eq(s.ipRateLimitBuckets.ipKey, `llm-day:${hashIp(IP)}`));
    expect(row.requestCount).toBe(50);
  });
});

describe("withCallerLimit — limits validated at construction", () => {
  it.each(["principalPerMinute", "ipPerMinute", "principalPerDay", "ipPerDay"] as const)(
    "a bad %s throws a typed ConfigError immediately, naming the option, never the caller",
    (name) => {
      const inner = answering();
      for (const bad of [0, -1, 1.5, NaN, Infinity]) {
        expect(() => withCallerLimit(inner, { db: t.db, principal: guest("secret-guest-id"), clientIp: IP, limits: { [name]: bad } })).toThrow(ConfigError);
      }
      let message = "";
      try {
        withCallerLimit(inner, { db: t.db, principal: guest("secret-guest-id"), clientIp: IP, limits: { [name]: 0 } });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain("secret-guest-id");
      expect(message).not.toContain(IP);
      expect(inner.callCount).toBe(0);
    },
  );
});
