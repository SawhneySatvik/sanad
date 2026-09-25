import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { USER_A_ID } from "@tests/support/services/draft";
import { deleteLibraryRow, renameLibraryRow, unassignLibraryRow } from "@/server/data/library";
import { saveToProject } from "@/server/data/projects";
import { create, revise } from "@/server/services/draft";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, draftModelOutput, userA, type Harness } from "@tests/support/services/draft";

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

function model() { return new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } }); }
async function root() {
  return create(h.deps(model()), userA, { mode: "from_scratch", documentType: "nda",
    userInstructions: "Draft an NDA.", jurisdiction: "IN" });
}
function heldRevision() {
  const llm = model();
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
  return { llm, waitForStart, resume };
}

it("a held revision inherits the chain title and project after rename and save", async () => {
  const first = await root();
  const [project] = await h.t.db.insert(schema.projects).values({ ownerUserId: USER_A_ID, name: "Matter" }).returning();
  const held = heldRevision();
  const pending = revise(h.deps(held.llm), userA, first.id, { userInstructions: "Make it shorter." });
  await held.waitForStart;
  await renameLibraryRow(h.t.db, userA, "draft", first.id, "Matter NDA");
  await saveToProject(h.t.db, userA, { kind: "draft", id: first.id }, project.id);
  held.resume();
  const revision = await pending;
  expect(revision.title).toBe("Matter NDA");
  const chain = await h.t.db.select().from(schema.drafts).orderBy(schema.drafts.revisionNumber);
  expect(chain.map((row) => [row.title, row.projectId])).toEqual([
    ["Matter NDA", project.id], ["Matter NDA", project.id],
  ]);
  await unassignLibraryRow(h.t.db, userA, "draft", first.id);
  expect((await h.t.db.select().from(schema.drafts)).every((row) => row.projectId === null)).toBe(true);
});

it("a held revision returns 404 after whole-chain deletion without an FK error", async () => {
  const first = await root();
  const held = heldRevision();
  const pending = revise(h.deps(held.llm), userA, first.id, { userInstructions: "Make it shorter." });
  await held.waitForStart;
  await deleteLibraryRow(h.t.db, userA, "draft", first.id);
  held.resume();
  await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await h.t.db.select().from(schema.drafts).where(eq(schema.drafts.id, first.id))).toHaveLength(0);
});
