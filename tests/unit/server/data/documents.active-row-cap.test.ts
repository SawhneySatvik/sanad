import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { DEFAULT_MAX_ACTIVE_ROWS, DOCUMENT_GUEST_TTL_SECONDS } from "@/server/data/documents";
import type { TestDb } from "@tests/support/db";
import { caught, createRepoTestDb, guestA, guestB, pendingDocument, userA } from "@tests/support/data/documents";

// Each principal may hold only so many active (unexpired) documents; creating one more is
// RATE_LIMITED, checked and inserted under one per-principal lock inside the create transaction.

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

async function documentCount(principal: Principal): Promise<number> {
  const owner =
    principal.type === "user" ? eq(schema.documents.ownerUserId, principal.userId) : eq(schema.documents.ownerGuestSessionId, principal.guestSessionId);
  return (await t.db.select().from(schema.documents).where(owner)).length;
}

describe("createPendingDocument — per-principal active-document cap", () => {
  it("the guest's cap-plus-one document is RATE_LIMITED with a retry-after within the guest TTL, and nothing is inserted", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "3");
    for (let i = 0; i < 3; i++) await pendingDocument(t, guestA);

    const error = await caught(pendingDocument(t, guestA));

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(DOCUMENT_GUEST_TTL_SECONDS);
    expect(await documentCount(guestA)).toBe(3);
  });

  it("an expired document no longer counts, and each principal has its own count", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "2");
    const first = await pendingDocument(t, guestA);
    await pendingDocument(t, guestA);
    expect((await caught(pendingDocument(t, guestA))).code).toBe("RATE_LIMITED");

    await pendingDocument(t, guestB);
    await t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.documents.id, first.id));

    await expect(pendingDocument(t, guestA)).resolves.toMatchObject({ ownerGuestSessionId: expect.any(String) });
    expect(await documentCount(guestA)).toBe(3);
  });

  it("a user has its own, separately configured cap; its rows never expire, so there is no retry-after", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "1");
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_USER", "2");
    await pendingDocument(t, userA);
    await pendingDocument(t, userA);

    const error = await caught(pendingDocument(t, userA));

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it(`without a valid override the guest cap is the default ${DEFAULT_MAX_ACTIVE_ROWS.guest}`, async () => {
    expect(DEFAULT_MAX_ACTIVE_ROWS.guest).toBeLessThan(DEFAULT_MAX_ACTIVE_ROWS.user);
    for (const invalid of ["", "abc", "0", "-5", "1e3", "2.5"]) {
      vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", invalid);
      await expect(pendingDocument(t, guestB)).resolves.toBeDefined();
    }
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "abc");
    for (let i = 0; i < DEFAULT_MAX_ACTIVE_ROWS.guest; i++) await pendingDocument(t, guestA);

    expect((await caught(pendingDocument(t, guestA))).code).toBe("RATE_LIMITED");
  });

  it("a large override lifts the default cap", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "999999999999");
    for (let i = 0; i < DEFAULT_MAX_ACTIVE_ROWS.guest + 1; i++) await pendingDocument(t, guestA);

    expect(await documentCount(guestA)).toBe(DEFAULT_MAX_ACTIVE_ROWS.guest + 1);
  });

  it("concurrent creates for one principal never overshoot the cap", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "5");

    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => pendingDocument(t, guestA)));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
    const rejected = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
    expect(rejected).toHaveLength(7);
    for (const reason of rejected) expect(reason).toBeInstanceOf(AppError);
    expect(rejected.map((reason: AppError) => reason.code)).toEqual(Array(7).fill("RATE_LIMITED"));
    expect(await documentCount(guestA)).toBe(5);
  });
});
