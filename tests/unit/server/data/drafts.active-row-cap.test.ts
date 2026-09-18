import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requiredSectionKeys } from "@/server/deterministic/draft-templates";
import { createDraft, reviseDraft, type NewDraftSectionInput } from "@/server/data/drafts";
import type { TestDb } from "@tests/support/db";
import { caught, createRepoTestDb, guestA } from "@tests/support/data/documents";

// Every draft row counts against the principal's active-draft cap, revisions included: each one is
// a row of its own. Checked inside the create transaction, under the per-principal lock.

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

const sections: NewDraftSectionInput[] = requiredSectionKeys("nda").map((key) => ({
  sectionKey: key,
  provenance: key === "disclaimer" || key === "signatures" ? "templated" : "ai_generated",
  content: `body for ${key}`,
}));

function draft() {
  return createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections, content: "content", modelUsed: "fake-model", jurisdiction: "IN" });
}

async function draftCount(): Promise<number> {
  const result = await t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM drafts");
  return result.rows[0].n;
}

describe("createDraft / reviseDraft — per-principal active-draft cap", () => {
  it("a revision counts as a row: at the cap, both a new draft and a revision are RATE_LIMITED and write nothing", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "2");
    const root = await draft();
    await reviseDraft(t.db, guestA, root.id, { sections, content: "revised", modelUsed: "fake-model" });

    expect((await caught(draft())).code).toBe("RATE_LIMITED");
    expect((await caught(reviseDraft(t.db, guestA, root.id, { sections, content: "again", modelUsed: "fake-model" }))).code).toBe("RATE_LIMITED");
    expect(await draftCount()).toBe(2);
  });

  it("concurrent creates never overshoot the cap", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "4");

    const outcomes = await Promise.allSettled(Array.from({ length: 9 }, () => draft()));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(4);
    expect(outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason.code] : []))).toEqual(Array(5).fill("RATE_LIMITED"));
    expect(await draftCount()).toBe(4);
  });
});
