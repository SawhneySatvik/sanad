import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compare } from "@/server/services/compare";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { type CompareHarness, createCompareHarness, explainAll, guestA, LEASE_A, LEASE_B } from "@tests/support/services/compare";

// The active-comparison cap is checked before the model call too, so a principal at the cap spends
// none of its model quota on a comparison that could not be stored.

let h: CompareHarness;
beforeEach(async () => {
  h = await createCompareHarness();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h.close();
});

describe("compare — the active-comparison cap", () => {
  it("at the cap: RATE_LIMITED with no model call and no comparison written", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "2");
    const documentA = await h.document(guestA, LEASE_A);
    const documentB = await h.document(guestA, LEASE_B);
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const input = { documentAId: documentA.id, documentBId: documentB.id };
    await compare(h.deps(llm), guestA, input);
    await compare(h.deps(llm), guestA, input);
    expect(llm.callCount).toBe(2);

    await expect(compare(h.deps(llm), guestA, input)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(llm.callCount).toBe(2);
    expect((await h.counts()).comparisons).toBe(2);
  });
});
