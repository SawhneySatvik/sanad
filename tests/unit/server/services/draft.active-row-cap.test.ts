import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, revise } from "@/server/services/draft";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, draftModelOutput, guestA, type Harness } from "@tests/support/services/draft";

// The active-draft cap is checked before the model call too, for a new draft and a revision alike,
// so a principal at the cap spends none of its model quota on a draft that could not be stored.

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h.close();
});

describe("create / revise — the active-draft cap", () => {
  it("at the cap: a new draft and a revision are both RATE_LIMITED with no model call", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "1");
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });
    const draft = await create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "A mutual NDA.", jurisdiction: "IN" });
    expect(llm.callCount).toBe(1);

    await expect(
      create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "Another.", jurisdiction: "IN" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(revise(h.deps(llm), guestA, draft.id, { userInstructions: "Shorter." })).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(llm.callCount).toBe(1);
    expect(await h.counts()).toMatchObject({ drafts: 1 });
  });
});
