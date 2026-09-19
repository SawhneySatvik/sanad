// The surfaced-error rule, through the production composition (createRateLimitedLlmClient, real
// PGlite). FallbackLlmClient's stream() recognises an error event by identity (errors.ts), so this
// proves the rate-limit decorators really pass events through unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "@tests/support/db";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { checkGlobalLimit, type Clock } from "@/server/rate-limit/limiter";
import { createRateLimitedLlmClient } from "@/server/rate-limit/rate-limited-llm-client";
import { normalizeProviderError } from "@/server/llm/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import type { LlmClient } from "@/server/llm/types";

const schema = z.object({ answer: z.string() });
const clock: Clock = { now: () => new Date("2026-09-23T10:00:00.000Z") };

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

function composed(primary: LlmClient, secondary: LlmClient, secondaryLimit = 5): LlmClient {
  return createRateLimitedLlmClient({
    db: t.db,
    primary,
    secondary,
    primaryProvider: "gemini",
    secondaryProvider: "gemma",
    primaryLimit: 5,
    secondaryLimit,
    principal: { type: "guest", guestSessionId: "t-126b" },
    principalLimit: 10,
    clock,
  });
}

async function events(client: LlmClient) {
  const out = [];
  for await (const event of client.stream({ systemPrompt: "s", userPrompt: "u", schema })) out.push(event);
  return out;
}

const timeout = () => new AppError("TIMEOUT", safeMessageFor("TIMEOUT"));

describe("the surfaced-error rule through the rate-limited composition", () => {
  it("Gemini timeout, then the backup's own 429: the caller gets TIMEOUT, not RATE_LIMITED (complete and stream)", async () => {
    const primary = () => new FakeLlmClient({ responses: [{ error: timeout() }] });
    const secondary = () => new FakeLlmClient({ responses: [{ error: normalizeProviderError({ status: 429 }) }] });

    await expect(composed(primary(), secondary()).complete({ systemPrompt: "s", userPrompt: "u", schema })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(await events(composed(primary(), secondary()))).toEqual([{ type: "error", code: "TIMEOUT", retryable: true }]);
  });

  it("Gemini timeout, then OUR limiter blocks the backup: RATE_LIMITED with its retry-after (complete and stream)", async () => {
    await checkGlobalLimit(t.db, "gemma", { limit: 1, clock }); // the backup's global bucket is full
    const secondary = new FakeLlmClient({ defaultResponse: { data: { answer: "must never be asked" } } });

    let caught: unknown;
    try {
      await composed(new FakeLlmClient({ responses: [{ error: timeout() }] }), secondary, 1).complete({ systemPrompt: "s", userPrompt: "u", schema });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "RATE_LIMITED" });
    expect((caught as AppError).retryAfterSeconds).toBeGreaterThan(0);

    expect(await events(composed(new FakeLlmClient({ responses: [{ error: timeout() }] }), secondary, 1))).toEqual([
      { type: "error", code: "RATE_LIMITED", retryable: true },
    ]);
    expect(secondary.callCount).toBe(0);
  });
});
