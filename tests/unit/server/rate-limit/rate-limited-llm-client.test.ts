import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import { ConfigError } from "@/server/core/env";
import { AppError, safeMessageFor } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { CircuitBreaker, FAILURE_THRESHOLD } from "@/server/llm/circuit-breaker";
import { normalizeProviderError, toStreamErrorEvent } from "@/server/llm/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { FallbackLlmClient, type LlmTier } from "@/server/llm/fallback";
import { TIER_BUDGET_SHARE } from "@/server/llm/timeouts";
import type { LlmClient, LlmCompleteInput, LlmStreamEvent } from "@/server/llm/types";
import { hashIp } from "@/server/rate-limit/ip-hash";
import {
  checkGlobalLimit,
  DEFAULT_GLOBAL_LIMIT,
  DEFAULT_IP_LLM_LIMIT,
  principalKeyFor,
  type Clock,
  type ProviderKey,
} from "@/server/rate-limit/limiter";
import { createRateLimitedLlmClient } from "@/server/rate-limit/rate-limited-llm-client";

const schema = z.object({ answer: z.string() });

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

describe("createRateLimitedLlmClient — both provider sides decorated + principal OUTSIDE, composed into a FallbackLlmClient", () => {
  it("primary over limit -> falls back to secondary; secondary's global bucket is incremented; modelUsed is the secondary's; principal charged once", async () => {
    const clock = fixedClock("2026-09-23T10:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock }); // fill gemini's bucket before construction

    const primary = new FakeLlmClient({ defaultResponse: { data: { answer: "primary should never answer" } } });
    const secondary = new FakeLlmClient({ modelUsed: "gemma", responses: [{ data: { answer: "from secondary" } }] });
    const principal = guest("fallback-charge");
    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 1,
      secondaryLimit: 5,
      principal,
      principalLimit: 10,
      clock,
    });

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(result.data).toEqual({ answer: "from secondary" });
    expect(result.modelUsed).toBe("gemma");
    expect(primary.callCount).toBe(0);
    expect(secondary.callCount).toBe(1);

    const [gemmaRow] = await t.db.select().from(s.globalLlmRateLimit).where(eq(s.globalLlmRateLimit.providerKey, "gemma"));
    expect(gemmaRow.requestCount).toBe(1);

    const [principalRow] = await t.db
      .select()
      .from(s.rateLimitBuckets)
      .where(eq(s.rateLimitBuckets.principalKey, principalKeyFor(principal)));
    expect(principalRow.requestCount).toBe(1);
  });

  it("BOTH sides over their limit: complete() rejects with typed RATE_LIMITED, ZERO inner calls on either side", async () => {
    const clock = fixedClock("2026-09-23T11:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock });
    await checkGlobalLimit(t.db, "gemma", { limit: 1, clock });

    const primary = new FakeLlmClient({ defaultResponse: { data: { answer: "primary should never answer" } } });
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "secondary should never answer" } } });
    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 1,
      secondaryLimit: 1,
      principal: guest("both-over"),
      clock,
    });

    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(primary.callCount).toBe(0);
    expect(secondary.callCount).toBe(0);
  });

  it("BOTH sides over their limit: stream() yields EXACTLY ONE RATE_LIMITED error event, ZERO inner calls on either side", async () => {
    const clock = fixedClock("2026-09-23T12:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock });
    await checkGlobalLimit(t.db, "gemma", { limit: 1, clock });

    const primary = new FakeLlmClient({ defaultResponse: { data: { answer: "primary should never answer" } } });
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "secondary should never answer" } } });
    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 1,
      secondaryLimit: 1,
      principal: guest("both-over-stream"),
      clock,
    });

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", code: "RATE_LIMITED", retryable: true }]);
    expect(primary.callCount).toBe(0);
    expect(secondary.callCount).toBe(0);
  });

  it("neither provider side over limit: primary answers normally, secondary is never touched", async () => {
    const clock = fixedClock("2026-09-23T13:00:00.000Z");
    const primary = new FakeLlmClient({ modelUsed: "gemini-2.0-flash", responses: [{ data: { answer: "from primary" } }] });
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      principal: guest("neither-over"),
      clock,
    });

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
    expect(result.data).toEqual({ answer: "from primary" });
    expect(primary.callCount).toBe(1);
    expect(secondary.callCount).toBe(0);
  });

  // The principal is the outermost layer — over its own limit, neither provider is ever touched,
  // regardless of either provider's own bucket state.
  it("principal over its own limit: rejected before either provider is touched, zero provider-bucket increments", async () => {
    const clock = fixedClock("2026-09-23T14:00:00.000Z");
    const principal = guest("principal-over");
    // Generous provider limits (1000) so neither provider bucket is ever the actual constraint —
    // this test is isolated to the principal tier alone.
    const primary = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 1000,
      secondaryLimit: 1000,
      principal,
      principalLimit: 1,
      clock,
    });

    await client.complete({ systemPrompt: "s", userPrompt: "u", schema }); // consumes the only principal slot
    await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    expect(primary.callCount).toBe(1); // only the first (allowed) call
    expect(secondary.callCount).toBe(0);
    // The provider bucket only ever saw the ONE real call the principal tier admitted — the second
    // (principal-rejected) attempt never reached withGlobalLimit at all, since principal is outermost.
    const [geminiRow] = await t.db.select().from(s.globalLlmRateLimit).where(eq(s.globalLlmRateLimit.providerKey, "gemini"));
    expect(geminiRow.requestCount).toBe(1);
  });
});

describe("createRateLimitedLlmClient — provider sides that are chains of tiers run as one flat chain", () => {
  const timeout = () => new AppError("TIMEOUT", safeMessageFor("TIMEOUT"));
  const upstream = () => new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));

  async function bucket(providerKey: "gemini" | "gemma"): Promise<number> {
    const [row] = await t.db.select().from(s.globalLlmRateLimit).where(eq(s.globalLlmRateLimit.providerKey, providerKey));
    return row?.requestCount ?? 0;
  }

  function compose(primary: LlmClient, secondary: LlmClient, principal: Principal, clock: Clock) {
    return createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 100,
      secondaryLimit: 100,
      principal,
      principalLimit: 100,
      clock,
    });
  }

  it("every tier's window is a share of the one operation budget, never a share of a share", async () => {
    // A tier that hangs until its window runs out, on a simulated clock.
    let now = 50_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const windows: number[] = [];
    const hung: LlmClient = {
      capabilities: { structuredOutput: true, nativeDocumentInput: true, streaming: true },
      async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<never> {
        windows.push(input.timeoutMs!);
        now += input.timeoutMs!;
        throw timeout();
      },
      async *stream<Schema extends ZodType>(): AsyncIterable<LlmStreamEvent<Schema>> {
        yield toStreamErrorEvent(timeout());
      },
    };
    const lite = new FakeLlmClient({ modelUsed: "gemini-lite", responses: [{ error: upstream() }] });
    const gemmaGoogle = new FakeLlmClient({ modelUsed: "gemma-google", defaultResponse: { data: { answer: "from gemma" } } });
    const gemmaNim = new FakeLlmClient({ modelUsed: "gemma-nim", defaultResponse: { data: { answer: "never" } } });

    try {
      const client = compose(new FallbackLlmClient(hung, lite), new FallbackLlmClient(gemmaGoogle, gemmaNim), guest("flat"), fixedClock("2026-09-23T18:00:00.000Z"));
      const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema, timeoutMs: 120_000 });

      expect(result.modelUsed).toBe("gemma-google");
      // Nested, the hung primary would get a share of its side's share (67.5 s of 120 s).
      expect(windows).toEqual([120_000 * TIER_BUDGET_SHARE]);
      // What is left of the one budget, capped by the same share of that one budget; nested, the Gemma
      // side would cap it at a share of the side's own remainder instead.
      expect(gemmaGoogle.calls[0].timeoutMs).toBe(Math.min(120_000 * (1 - TIER_BUDGET_SHARE), 120_000 * TIER_BUDGET_SHARE));
      expect(gemmaNim.callCount).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("each tier attempt is charged to its side's bucket; the principal once", async () => {
    const clock = fixedClock("2026-09-23T19:00:00.000Z");
    const principal = guest("per-tier-charge");
    const flash = new FakeLlmClient({ modelUsed: "flash", responses: [{ error: upstream() }] });
    const lite = new FakeLlmClient({ modelUsed: "lite", responses: [{ error: upstream() }] });
    const gemma = new FakeLlmClient({ modelUsed: "gemma", responses: [{ data: { answer: "from gemma" } }] });

    const result = await compose(new FallbackLlmClient(flash, lite), new FallbackLlmClient(gemma), principal, clock).complete({
      systemPrompt: "s",
      userPrompt: "u",
      schema,
    });

    expect(result.modelUsed).toBe("gemma");
    expect(await bucket("gemini")).toBe(2);
    expect(await bucket("gemma")).toBe(1);
    const [principalRow] = await t.db.select().from(s.rateLimitBuckets).where(eq(s.rateLimitBuckets.principalKey, principalKeyFor(principal)));
    expect(principalRow.requestCount).toBe(1);
  });

  it("a tier skipped by its open circuit breaker costs no quota: its bucket is not charged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const breaker = new CircuitBreaker("gemini:flash");
    for (let i = 0; i < FAILURE_THRESHOLD; i++) breaker.recordFailure(upstream());
    const flash = new FakeLlmClient({ modelUsed: "flash", defaultResponse: { data: { answer: "never" } } });
    const gemma = new FakeLlmClient({ modelUsed: "gemma", responses: [{ data: { answer: "from gemma" } }] });

    try {
      const result = await compose(new FallbackLlmClient({ client: flash, breaker }), gemma, guest("breaker-skip"), fixedClock("2026-09-23T20:00:00.000Z")).complete({
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      });

      expect(result.modelUsed).toBe("gemma");
      expect(flash.callCount).toBe(0);
      expect(await bucket("gemini")).toBe(0);
      expect(await bucket("gemma")).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createRateLimitedLlmClient — tagged tiers charge their OWN rate-limit key, isolated from the rest of their side", () => {
  async function bucketCount(providerKey: ProviderKey): Promise<number> {
    const [row] = await t.db.select().from(s.globalLlmRateLimit).where(eq(s.globalLlmRateLimit.providerKey, providerKey));
    return row?.requestCount ?? 0;
  }

  function tagged(client: LlmClient, rateLimitKey: string): LlmTier {
    return { client, rateLimitKey };
  }

  function unavailable(): AppError {
    return normalizeProviderError({ status: 503 }); // carries a status, so it's a real provider failure, not a transport retry
  }

  it("gemini bucket full: gemini_fallback still answers from its own bucket, untouched by the primary's exhaustion", async () => {
    const clock = fixedClock("2026-09-23T21:00:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock }); // exhausts gemini before construction

    const flash = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const lite = new FakeLlmClient({ modelUsed: "lite", responses: [{ data: { answer: "from lite" } }] });
    const primary = new FallbackLlmClient(tagged(flash, "gemini"), tagged(lite, "gemini_fallback"));
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });

    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 1,
      secondaryLimit: 100,
      principal: guest("isolation-gemini"),
      principalLimit: 100,
      clock,
    });

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(result.modelUsed).toBe("lite");
    expect(flash.callCount).toBe(0);
    expect(await bucketCount("gemini")).toBe(2); // the pre-fill plus the blocked attempt — still charged, then rejected
    expect(await bucketCount("gemini_fallback")).toBe(1);
    expect(await bucketCount("gemma_google")).toBe(0);
    expect(await bucketCount("gemma")).toBe(0);
  });

  it("gemma bucket full: gemma_google still answers from its own bucket", async () => {
    const clock = fixedClock("2026-09-23T21:05:00.000Z");
    await checkGlobalLimit(t.db, "gemma", { limit: 1, clock }); // exhausts gemma before construction

    const primaryFail = new FakeLlmClient({ responses: [{ error: unavailable() }] });
    const nim = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const google = new FakeLlmClient({ modelUsed: "gemma-google", responses: [{ data: { answer: "from google" } }] });
    // NIM tried first (shares the exhausted "gemma" key) so it's rejected; Google tried next
    // (its own "gemma_google" key, untouched) so it answers.
    const secondary = new FallbackLlmClient(tagged(nim, "gemma"), tagged(google, "gemma_google"));

    const client = createRateLimitedLlmClient({
      db: t.db,
      primary: primaryFail,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 100,
      secondaryLimit: 1,
      principal: guest("isolation-gemma"),
      principalLimit: 100,
      clock,
    });

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(result.modelUsed).toBe("gemma-google");
    expect(nim.callCount).toBe(0);
    expect(await bucketCount("gemma")).toBe(2); // the pre-fill plus NIM's blocked attempt
    expect(await bucketCount("gemma_google")).toBe(1);
  });

  it("gemma_google bucket full: NIM still answers, charged to the shared gemma key", async () => {
    // Tagged tiers with their OWN key resolve that key's own override/default, not secondaryLimit —
    // so exhausting gemma_google's real (env-driven) limit, not just the pre-fill call's own limit
    // argument, needs an env override matching the pre-fill.
    vi.stubEnv("RATE_LIMIT_GEMMA_GOOGLE_PER_MINUTE", "1");
    try {
      const clock = fixedClock("2026-09-23T21:10:00.000Z");
      await checkGlobalLimit(t.db, "gemma_google", { limit: 1, clock }); // exhausts gemma_google before construction

      const primaryFail = new FakeLlmClient({ responses: [{ error: unavailable() }] });
      const google = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
      const nim = new FakeLlmClient({ modelUsed: "gemma-nim", responses: [{ data: { answer: "from nim" } }] });
      const secondary = new FallbackLlmClient(tagged(google, "gemma_google"), tagged(nim, "gemma"));

      const client = createRateLimitedLlmClient({
        db: t.db,
        primary: primaryFail,
        secondary,
        primaryProvider: "gemini",
        secondaryProvider: "gemma",
        primaryLimit: 100,
        secondaryLimit: 100,
        principal: guest("isolation-gemma-google"),
        principalLimit: 100,
        clock,
      });

      const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

      expect(result.modelUsed).toBe("gemma-nim");
      expect(google.callCount).toBe(0);
      expect(await bucketCount("gemma_google")).toBe(2);
      expect(await bucketCount("gemma")).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("one call through all five tiers: tiers 1–4 fail, tier 5 answers — buckets are gemini 1, gemini_fallback 1, gemma_google 1, gemma 2", async () => {
    const clock = fixedClock("2026-09-23T21:15:00.000Z");
    const flash = new FakeLlmClient({ responses: [{ error: unavailable() }] });
    const lite = new FakeLlmClient({ responses: [{ error: unavailable() }] });
    const google = new FakeLlmClient({ responses: [{ error: unavailable() }] });
    const nim = new FakeLlmClient({ responses: [{ error: unavailable() }] });
    const openrouter = new FakeLlmClient({ modelUsed: "openrouter", responses: [{ data: { answer: "from openrouter" } }] });

    const primary = new FallbackLlmClient(tagged(flash, "gemini"), tagged(lite, "gemini_fallback"));
    const secondary = new FallbackLlmClient(tagged(google, "gemma_google"), tagged(nim, "gemma"), tagged(openrouter, "gemma"));

    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 100,
      secondaryLimit: 100,
      principal: guest("charge-map"),
      principalLimit: 100,
      clock,
    });

    const result = await client.complete({ systemPrompt: "s", userPrompt: "u", schema });

    expect(result.modelUsed).toBe("openrouter");
    expect(await bucketCount("gemini")).toBe(1);
    expect(await bucketCount("gemini_fallback")).toBe(1);
    expect(await bucketCount("gemma_google")).toBe(1);
    expect(await bucketCount("gemma")).toBe(2); // NIM and OpenRouter share this key
  });

  function allFourLimitedClient(clock: Clock, guestId: string) {
    const flash = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const lite = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const google = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const nim = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const primary = new FallbackLlmClient(tagged(flash, "gemini"), tagged(lite, "gemini_fallback"));
    const secondary = new FallbackLlmClient(tagged(google, "gemma_google"), tagged(nim, "gemma"));
    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 1,
      secondaryLimit: 1,
      principal: guest(guestId),
      principalLimit: 100,
      clock,
    });
    return { client, fakes: [flash, lite, google, nim] };
  }

  // gemini_fallback and gemma_google are tagged with a key different from their side, so
  // primaryLimit/secondaryLimit don't reach them (see the file header) — their own env var has to
  // be stubbed to the same limit the pre-fill exhausts, same as the single-key isolation test above.
  function stubNonSideKeyLimits(): void {
    vi.stubEnv("RATE_LIMIT_GEMINI_FALLBACK_PER_MINUTE", "1");
    vi.stubEnv("RATE_LIMIT_GEMMA_GOOGLE_PER_MINUTE", "1");
  }

  it("every tier over its own limit: complete() rejects RATE_LIMITED, ZERO inner calls on any tier", async () => {
    stubNonSideKeyLimits();
    try {
      const clock = fixedClock("2026-09-23T21:20:00.000Z");
      for (const key of ["gemini", "gemini_fallback", "gemma_google", "gemma"] as const) {
        await checkGlobalLimit(t.db, key, { limit: 1, clock });
      }
      const { client, fakes } = allFourLimitedClient(clock, "all-limited-complete");

      await expect(client.complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({ code: "RATE_LIMITED" });
      for (const fake of fakes) expect(fake.callCount).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("every tier over its own limit: stream() yields EXACTLY ONE RATE_LIMITED error event, ZERO inner calls", async () => {
    stubNonSideKeyLimits();
    try {
      const clock = fixedClock("2026-09-23T21:25:00.000Z");
      for (const key of ["gemini", "gemini_fallback", "gemma_google", "gemma"] as const) {
        await checkGlobalLimit(t.db, key, { limit: 1, clock });
      }
      const { client, fakes } = allFourLimitedClient(clock, "all-limited-stream");

      const events = [];
      for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
        events.push(event);
      }
      expect(events).toEqual([{ type: "error", code: "RATE_LIMITED", retryable: true }]);
      for (const fake of fakes) expect(fake.callCount).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stream(): gemini bucket full skips to gemini_fallback, which answers", async () => {
    const clock = fixedClock("2026-09-23T21:30:00.000Z");
    await checkGlobalLimit(t.db, "gemini", { limit: 1, clock });

    const flash = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const lite = new FakeLlmClient({ modelUsed: "lite", responses: [{ data: { answer: "from lite" } }] });
    const primary = new FallbackLlmClient(tagged(flash, "gemini"), tagged(lite, "gemini_fallback"));
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });

    const client = createRateLimitedLlmClient({
      db: t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      primaryLimit: 1,
      secondaryLimit: 100,
      principal: guest("stream-skip"),
      principalLimit: 100,
      clock,
    });

    const events = [];
    for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) {
      events.push(event);
    }
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ modelUsed: "lite" });
    expect(flash.callCount).toBe(0);
  });

  it("an unrecognized rateLimitKey throws a typed ConfigError at construction, before any call", () => {
    const flash = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });
    const primary = new FallbackLlmClient({ client: flash, rateLimitKey: "not-a-real-key" });
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "should never be reached" } } });

    expect(() =>
      createRateLimitedLlmClient({
        db: t.db,
        primary,
        secondary,
        primaryProvider: "gemini",
        secondaryProvider: "gemma",
        principal: guest("bad-key"),
        clock: fixedClock("2026-09-23T21:35:00.000Z"),
      }),
    ).toThrow(ConfigError);
    expect(flash.callCount).toBe(0);
  });
});

// A guest principal is self-issued: a script that sheds its cookie gets a fresh principal bucket per
// request. The five-tier production chain, default limits, one fixed window — each "Ask" is three
// logical calls, stopping at the first refusal.
describe("createRateLimitedLlmClient — cookie cycling from one IP can't fill the shared buckets", () => {
  const clock = fixedClock("2026-09-23T22:00:30.000Z");

  function chain() {
    const leaf = (modelUsed: string) => new FakeLlmClient({ modelUsed, defaultResponse: { data: { answer: "x" } } });
    const leaves = [leaf("flash"), leaf("lite"), leaf("gemma-google"), leaf("nim"), leaf("openrouter")];
    const [flash, lite, google, nim, openrouter] = leaves;
    return {
      leaves,
      primary: new FallbackLlmClient({ client: flash, rateLimitKey: "gemini" }, { client: lite, rateLimitKey: "gemini_fallback" }),
      secondary: new FallbackLlmClient(
        { client: google, rateLimitKey: "gemma_google" },
        { client: nim, rateLimitKey: "gemma" },
        { client: openrouter, rateLimitKey: "gemma" },
      ),
    };
  }

  async function twentyGuests(ipOf: (guestIndex: number) => string) {
    const { leaves, primary, secondary } = chain();
    let asksServed = 0;
    for (let n = 0; n < 20; n++) {
      const client = createRateLimitedLlmClient({
        db: t.db,
        primary,
        secondary,
        primaryProvider: "gemini",
        secondaryProvider: "gemma",
        principal: guest(`cycled-${n}`),
        clientIp: ipOf(n),
        clock,
      });
      try {
        for (let i = 0; i < 3; i++) await client.complete({ systemPrompt: "s", userPrompt: "u", schema });
        asksServed++;
      } catch (error) {
        expect(error).toMatchObject({ code: "RATE_LIMITED" });
      }
    }
    const buckets = await t.db.select().from(s.globalLlmRateLimit);
    return {
      asksServed,
      leafCalls: leaves.reduce((sum, leaf) => sum + leaf.callCount, 0),
      global: Object.fromEntries(buckets.map((row) => [row.providerKey, row.requestCount])) as Partial<Record<ProviderKey, number>>,
    };
  }

  it("20 fresh guests, one IP: the IP's per-call tier admits DEFAULT_IP_LLM_LIMIT calls, and no global bucket reaches its default", async () => {
    const result = await twentyGuests(() => "203.0.113.77");

    expect(result.leafCalls).toBe(DEFAULT_IP_LLM_LIMIT);
    expect(result.asksServed).toBe(Math.floor(DEFAULT_IP_LLM_LIMIT / 3));
    for (const providerKey of Object.keys(DEFAULT_GLOBAL_LIMIT) as ProviderKey[]) {
      expect(result.global[providerKey] ?? 0).toBeLessThan(DEFAULT_GLOBAL_LIMIT[providerKey]);
    }
    const [ipRow] = await t.db.select().from(s.ipRateLimitBuckets).where(eq(s.ipRateLimitBuckets.ipKey, `llm:${hashIp("203.0.113.77")}`));
    // Each guest that was refused stopped at its first refused call, which is still counted.
    expect(ipRow.requestCount).toBe(DEFAULT_IP_LLM_LIMIT + (20 - result.asksServed));
  });

  it("positive control: the same 20 guests from 20 different IPs DO fill every global bucket — the IP tier is what stopped them above", async () => {
    const result = await twentyGuests((n) => `198.51.100.${n + 1}`);

    expect(result.leafCalls).toBeGreaterThan(DEFAULT_IP_LLM_LIMIT);
    for (const providerKey of Object.keys(DEFAULT_GLOBAL_LIMIT) as ProviderKey[]) {
      expect(result.global[providerKey]).toBeGreaterThanOrEqual(DEFAULT_GLOBAL_LIMIT[providerKey]);
    }
  });

  it("a call that walks three tiers charges the IP's per-call bucket once, not per tier", async () => {
    const upstream = () => new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
    const flash = new FakeLlmClient({ responses: [{ error: upstream() }] });
    const lite = new FakeLlmClient({ responses: [{ error: upstream() }] });
    const gemma = new FakeLlmClient({ modelUsed: "gemma", responses: [{ data: { answer: "from gemma" } }] });
    const client = createRateLimitedLlmClient({
      db: t.db,
      primary: new FallbackLlmClient(flash, lite),
      secondary: gemma,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      principal: guest("walker"),
      clientIp: "203.0.113.78",
      clock,
    });

    expect((await client.complete({ systemPrompt: "s", userPrompt: "u", schema })).modelUsed).toBe("gemma");
    const ipRows = await t.db.select().from(s.ipRateLimitBuckets);
    expect(ipRows.map((row) => [row.ipKey, row.requestCount]).sort()).toEqual(
      [[`llm-day:${hashIp("203.0.113.78")}`, 1], [`llm:${hashIp("203.0.113.78")}`, 1]].sort(),
    );
  });

  it("with no clientIp, every caller shares the one UNKNOWN_CLIENT_IP bucket — never an unlimited one", async () => {
    const { primary, secondary } = chain();
    const outcomes = [];
    for (let n = 0; n < 2; n++) {
      const client = createRateLimitedLlmClient({
        db: t.db,
        primary,
        secondary,
        primaryProvider: "gemini",
        secondaryProvider: "gemma",
        principal: guest(`no-ip-${n}`),
        ipLlmLimit: 1,
        clock,
      });
      outcomes.push(await client.complete({ systemPrompt: "s", userPrompt: "u", schema }).then(() => "ok", (error: AppError) => error.code));
    }
    expect(outcomes).toEqual(["ok", "RATE_LIMITED"]);
  });
});
