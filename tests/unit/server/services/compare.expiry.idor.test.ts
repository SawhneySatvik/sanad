import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { compare } from "@/server/services/compare";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createCompareHarness, explainAll, guestA, LEASE_A, LEASE_B, type CompareHarness } from "@tests/support/services/compare";

let h: CompareHarness;
beforeEach(async () => { h = await createCompareHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

it("declines an expired guest document before spending a model call", async () => {
  const a = await h.document(guestA, LEASE_A);
  const b = await h.document(guestA, LEASE_B);
  await h.t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.documents.id, a.id));
  const llm = new FakeLlmClient({ defaultResponse: explainAll() });
  await expect(compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id }))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(llm.callCount).toBe(0);
});

it("declines an input that expires while the model call is held", async () => {
  const a = await h.document(guestA, LEASE_A);
  const b = await h.document(guestA, LEASE_B);
  const llm = new FakeLlmClient({ defaultResponse: explainAll() });
  let resume!: () => void;
  let started!: () => void;
  const waitForStart = new Promise<void>((resolve) => { started = resolve; });
  const waitForResume = new Promise<void>((resolve) => { resume = resolve; });
  const complete = llm.complete.bind(llm);
  vi.spyOn(llm, "complete").mockImplementation(async (input) => {
    started();
    await waitForResume;
    return complete(input);
  });
  const pending = compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });
  await waitForStart;
  await h.t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.documents.id, a.id));
  resume();
  await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await h.counts()).comparisons).toBe(0);
});
