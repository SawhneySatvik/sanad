import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComparison } from "@/server/data/comparisons";
import type { TestDb } from "@tests/support/db";
import { caught, createRepoTestDb, guestA, guestB, readyDocument } from "@tests/support/data/documents";

// createComparison checks a principal's active-comparison cap inside its own transaction, under the
// per-principal lock, after the model call — so concurrent writes cannot overshoot it either.

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

async function comparisonCount(): Promise<number> {
  const result = await t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM comparisons");
  return result.rows[0].n;
}

async function comparable() {
  const documentA = await readyDocument(t, guestA);
  const documentB = await readyDocument(t, guestA);
  return () => createComparison(t.db, guestA, { documentAId: documentA.id, documentBId: documentB.id, modelUsed: "none", changes: [] });
}

describe("createComparison — per-principal active-comparison cap", () => {
  it("the cap-plus-one comparison is RATE_LIMITED and writes nothing; another principal is unaffected", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "2");
    const create = await comparable();
    await create();
    await create();

    expect((await caught(create())).code).toBe("RATE_LIMITED");
    expect(await comparisonCount()).toBe(2);

    const otherA = await readyDocument(t, guestB);
    const otherB = await readyDocument(t, guestB);
    await createComparison(t.db, guestB, { documentAId: otherA.id, documentBId: otherB.id, modelUsed: "none", changes: [] });
    expect(await comparisonCount()).toBe(3);
  });

  it("concurrent creates never overshoot the cap", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "3");
    const create = await comparable();

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => create()));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    expect(outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason.code] : []))).toEqual(Array(5).fill("RATE_LIMITED"));
    expect(await comparisonCount()).toBe(3);
  });
});
