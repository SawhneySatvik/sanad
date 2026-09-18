// Projects repository: create/list/detail, and retroactive save-to-project. Cross-principal cases
// are in projects.idor.test.ts.

import { asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { createProject, getProject, listProjects, saveToProject } from "@/server/data/projects";
import {
  caught,
  createProjectsTestDb,
  guestA,
  insertComparison,
  insertDocument,
  insertDraftChain,
  insertThread,
  inAnHour,
  userA,
  USER_A_ID,
  userB,
} from "@tests/support/data/projects";

let t: TestDb;
beforeEach(async () => {
  t = await createProjectsTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("createProject", () => {
  it("creates a project owned by the user", async () => {
    const project = await createProject(t.db, userA, { name: "Flat lease", color: "teal", icon: "home" });
    expect(project).toMatchObject({ ownerUserId: USER_A_ID, name: "Flat lease", color: "teal", icon: "home" });
    expect(await t.db.select().from(schema.projects)).toHaveLength(1);
  });

  it("refuses a guest with VALIDATION_FAILED and a blank name likewise; neither creates a row", async () => {
    expect((await caught(createProject(t.db, guestA, { name: "Mine" }))).code).toBe("VALIDATION_FAILED");
    expect((await caught(createProject(t.db, userA, { name: "  " }))).code).toBe("VALIDATION_FAILED");
    expect(await t.db.select().from(schema.projects)).toHaveLength(0);
  });
});

describe("listProjects", () => {
  it("returns only the caller's projects, most recently opened first; a guest gets none", async () => {
    const older = await createProject(t.db, userA, { name: "older" });
    const newer = await createProject(t.db, userA, { name: "newer" });
    await t.db.update(schema.projects).set({ openedAt: new Date(Date.now() - 60_000) }).where(eq(schema.projects.id, older.id));
    await createProject(t.db, userB, { name: "b's" });

    expect((await listProjects(t.db, userA)).map((p) => p.id)).toEqual([newer.id, older.id]);
    expect(await listProjects(t.db, userB)).toHaveLength(1);
    expect(await listProjects(t.db, guestA)).toEqual([]);
  });
});

describe("getProject", () => {
  it("lists the project's documents, comparisons, drafts and threads — without canonical_text, storage_ref or draft content", async () => {
    const project = await createProject(t.db, userA, { name: "p" });
    const document = await insertDocument(t, userA, null);
    const other = await insertDocument(t, userA, null);
    const comparison = await insertComparison(t, userA, document.id, other.id, null);
    const chain = await insertDraftChain(t, userA, null, document.id);
    const thread = await insertThread(t, USER_A_ID);
    for (const item of [
      { kind: "document", id: document.id },
      { kind: "comparison", id: comparison.id },
      { kind: "draft", id: chain[0].id },
      { kind: "thread", id: thread.id },
    ] as const) {
      await saveToProject(t.db, userA, item, project.id);
    }

    const detail = await getProject(t.db, userA, project.id);

    expect(detail.project.id).toBe(project.id);
    // `other` was never saved: standalone items stay out.
    expect(detail.documents.map((d) => d.id)).toEqual([document.id]);
    expect(detail.comparisons.map((c) => c.id)).toEqual([comparison.id]);
    expect(detail.drafts.map((d) => d.id).sort()).toEqual(chain.map((d) => d.id).sort());
    expect(detail.threads.map((th) => th.id)).toEqual([thread.id]);
    expect(detail.documents[0]).not.toHaveProperty("canonicalText");
    expect(detail.documents[0]).not.toHaveProperty("storageRef");
    expect(detail.drafts[0]).not.toHaveProperty("content");
    expect(JSON.stringify(detail)).not.toContain(document.canonicalText!);
  });

  it("does not bump opened_at on a read", async () => {
    const project = await createProject(t.db, userA, { name: "p" });
    await getProject(t.db, userA, project.id);
    const [row] = await t.db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(row.openedAt).toEqual(project.openedAt);
  });
});

describe("saveToProject", () => {
  it("saves each kind: sets project_id and clears expires_at in the same statement", async () => {
    const project = await createProject(t.db, userA, { name: "p" });
    // User rows carrying an expires_at: saving must take them out of any sweep scope.
    const document = await insertDocument(t, userA, inAnHour());
    const other = await insertDocument(t, userA, null);
    const comparison = await insertComparison(t, userA, document.id, other.id, inAnHour());
    const thread = await insertThread(t, USER_A_ID);

    expect(await saveToProject(t.db, userA, { kind: "document", id: document.id }, project.id)).toEqual({
      projectId: project.id,
      kind: "document",
      itemIds: [document.id],
    });
    await saveToProject(t.db, userA, { kind: "comparison", id: comparison.id }, project.id);
    await saveToProject(t.db, userA, { kind: "thread", id: thread.id }, project.id);

    const [savedDocument] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, document.id));
    const [savedComparison] = await t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, comparison.id));
    const [savedThread] = await t.db.select().from(schema.threads).where(eq(schema.threads.id, thread.id));
    expect(savedDocument).toMatchObject({ projectId: project.id, expiresAt: null });
    expect(savedComparison).toMatchObject({ projectId: project.id, expiresAt: null });
    expect(savedThread.projectId).toBe(project.id);
    // Only the saved rows moved.
    const [untouched] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, other.id));
    expect(untouched.projectId).toBeNull();
  });

  it("moves an item from one of the caller's projects to another", async () => {
    const first = await createProject(t.db, userA, { name: "first" });
    const second = await createProject(t.db, userA, { name: "second" });
    const document = await insertDocument(t, userA, null);

    await saveToProject(t.db, userA, { kind: "document", id: document.id }, first.id);
    await saveToProject(t.db, userA, { kind: "document", id: document.id }, second.id);

    expect((await getProject(t.db, userA, first.id)).documents).toEqual([]);
    expect((await getProject(t.db, userA, second.id)).documents.map((d) => d.id)).toEqual([document.id]);
  });

  it("saving any revision saves its whole draft chain — ancestors, descendants and sibling branches — and clears every expires_at", async () => {
    const project = await createProject(t.db, userA, { name: "p" });
    const chain = await insertDraftChain(t, userA, inAnHour(), null, 3);
    const [branch] = await t.db
      .insert(schema.drafts)
      .values({
        ownerUserId: USER_A_ID,
        documentType: "leave_and_license",
        mode: "from_scratch",
        content: "branch",
        revisionNumber: 2,
        parentDraftId: chain[0].id,
        modelUsed: "gemini-test",
        expiresAt: chain[0].expiresAt,
      })
      .returning();
    const unrelated = await insertDraftChain(t, userA, inAnHour(), null, 1);
    const whole = [...chain.map((d) => d.id), branch.id];

    const saved = await saveToProject(t.db, userA, { kind: "draft", id: chain[1].id }, project.id);

    expect(saved.itemIds.sort()).toEqual(whole.sort());
    const rows = await t.db.select().from(schema.drafts).where(inArray(schema.drafts.id, whole)).orderBy(asc(schema.drafts.id));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ projectId: project.id, expiresAt: null });
    const [left] = await t.db.select().from(schema.drafts).where(eq(schema.drafts.id, unrelated[0].id));
    expect(left.projectId).toBeNull();
    expect(left.expiresAt).not.toBeNull();
  });

  it("a malformed self-referencing draft still saves (the chain walk terminates)", async () => {
    const project = await createProject(t.db, userA, { name: "p" });
    const id = "3c3c3c3c-0000-4000-8000-00000000000c";
    await t.db.insert(schema.drafts).values({
      id,
      ownerUserId: USER_A_ID,
      documentType: "generic",
      mode: "from_scratch",
      content: "loop",
      revisionNumber: 1,
      parentDraftId: id,
      modelUsed: "gemini-test",
    });

    expect((await saveToProject(t.db, userA, { kind: "draft", id }, project.id)).itemIds).toEqual([id]);
  });
});
