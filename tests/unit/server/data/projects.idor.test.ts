// Cross-principal access to the projects repository. Every denial is
// the same NOT_FOUND — same code AND same message — as a missing or malformed id, and changes nothing;
// every group has a positive control the owner passes.

import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { createProject, getProject, listProjects, saveToProject, type ProjectItemKind } from "@/server/data/projects";
import {
  caught,
  createProjectsTestDb,
  guestA,
  insertComparison,
  insertDocument,
  insertDraftChain,
  insertThread,
  userA,
  USER_A_ID,
  userB,
  USER_B_ID,
} from "@tests/support/data/projects";

let t: TestDb;
beforeEach(async () => {
  t = await createProjectsTestDb();
});
afterEach(async () => {
  await t.close();
});

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";
const MALFORMED_ID = "not-a-uuid";

async function notFound(promise: Promise<unknown>) {
  const error = await caught(promise);
  return { code: error.code, message: error.message };
}

async function everything(db: TestDb) {
  return {
    documents: await db.db.select().from(schema.documents).orderBy(asc(schema.documents.id)),
    comparisons: await db.db.select().from(schema.comparisons).orderBy(asc(schema.comparisons.id)),
    drafts: await db.db.select().from(schema.drafts).orderBy(asc(schema.drafts.id)),
    threads: await db.db.select().from(schema.threads).orderBy(asc(schema.threads.id)),
  };
}

// One item of each kind for a user.
async function itemsOf(principal: Principal, ownerUserId: string) {
  const document = await insertDocument(t, principal, null);
  const other = await insertDocument(t, principal, null);
  const comparison = await insertComparison(t, principal, document.id, other.id, null);
  const [draft] = await insertDraftChain(t, principal, null, null, 1);
  const thread = await insertThread(t, ownerUserId);
  return { document: document.id, comparison: comparison.id, draft: draft.id, thread: thread.id } satisfies Record<ProjectItemKind, string>;
}

const KINDS: ProjectItemKind[] = ["document", "comparison", "draft", "thread"];

describe("getProject IDOR", () => {
  it("another user's project, a missing id, a malformed id and any guest are the same NOT_FOUND; the owner reads it", async () => {
    const project = await createProject(t.db, userA, { name: "a's" });
    const missing = await notFound(getProject(t.db, userA, MISSING_ID));

    expect(missing.code).toBe("NOT_FOUND");
    expect(await notFound(getProject(t.db, userB, project.id))).toEqual(missing);
    expect(await notFound(getProject(t.db, guestA, project.id))).toEqual(missing);
    expect(await notFound(getProject(t.db, userA, MALFORMED_ID))).toEqual(missing);
    await expect(getProject(t.db, userA, project.id)).resolves.toMatchObject({ project: { id: project.id } });
  });

  it("a foreign nested assignment makes project detail 404; the owner's rows appear once malformed links are removed", async () => {
    const project = await createProject(t.db, userA, { name: "a's" });
    const mine = await itemsOf(userA, USER_A_ID);
    const foreign = await itemsOf(userB, USER_B_ID);
    const guestsDocument = await insertDocument(t, guestA, new Date(Date.now() + 3_600_000));
    const guestsDraft = (await insertDraftChain(t, guestA, new Date(Date.now() + 3_600_000), null, 1))[0];
    // Written directly: no repository path can produce the foreign rows, which is the point.
    const plant = async (table: string, ids: string[]) => {
      for (const id of ids) await t.client.query(`UPDATE ${table} SET project_id = $1 WHERE id = $2`, [project.id, id]);
    };
    await plant("documents", [mine.document, foreign.document, guestsDocument.id]);
    await plant("comparisons", [mine.comparison, foreign.comparison]);
    await plant("drafts", [mine.draft, foreign.draft, guestsDraft.id]);
    await plant("threads", [mine.thread, foreign.thread]);

    await expect(getProject(t.db, userA, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const unplant = async (table: string, ids: string[]) => {
      for (const id of ids) await t.client.query(`UPDATE ${table} SET project_id = NULL WHERE id = $1`, [id]);
    };
    await unplant("documents", [foreign.document, guestsDocument.id]);
    await unplant("comparisons", [foreign.comparison]);
    await unplant("drafts", [foreign.draft, guestsDraft.id]);
    await unplant("threads", [foreign.thread]);
    const detail = await getProject(t.db, userA, project.id);
    expect(detail.documents.map((d) => d.id)).toEqual([mine.document]);
    expect(detail.comparisons.map((c) => c.id)).toEqual([mine.comparison]);
    expect(detail.drafts.map((d) => d.id)).toEqual([mine.draft]);
    expect(detail.threads.map((th) => th.id)).toEqual([mine.thread]);
  });

  it("listProjects never returns another user's project", async () => {
    await createProject(t.db, userB, { name: "b's" });
    const mine = await createProject(t.db, userA, { name: "a's" });
    expect((await listProjects(t.db, userA)).map((p) => p.id)).toEqual([mine.id]);
  });
});

describe("saveToProject IDOR (multi-entity rule: item AND project)", () => {
  for (const kind of KINDS) {
    it(`${kind}: a foreign item into my project, my item into a foreign project, and missing/malformed ids are one NOT_FOUND that changes nothing`, async () => {
      const mineProject = await createProject(t.db, userA, { name: "a's" });
      const foreignProject = await createProject(t.db, userB, { name: "b's" });
      const mine = await itemsOf(userA, USER_A_ID);
      const foreign = await itemsOf(userB, USER_B_ID);
      const before = await everything(t);
      const missing = await notFound(saveToProject(t.db, userA, { kind, id: MISSING_ID }, mineProject.id));

      expect(missing.code).toBe("NOT_FOUND");
      expect(await notFound(saveToProject(t.db, userA, { kind, id: foreign[kind] }, mineProject.id))).toEqual(missing);
      expect(await notFound(saveToProject(t.db, userA, { kind, id: mine[kind] }, foreignProject.id))).toEqual(missing);
      expect(await notFound(saveToProject(t.db, userA, { kind, id: foreign[kind] }, foreignProject.id))).toEqual(missing);
      expect(await notFound(saveToProject(t.db, userA, { kind, id: mine[kind] }, MISSING_ID))).toEqual(missing);
      expect(await notFound(saveToProject(t.db, userA, { kind, id: MALFORMED_ID }, mineProject.id))).toEqual(missing);
      expect(await notFound(saveToProject(t.db, userA, { kind, id: mine[kind] }, MALFORMED_ID))).toEqual(missing);
      // An id of another kind is not an item of this kind.
      const otherKind = KINDS.find((k) => k !== kind)!;
      expect(await notFound(saveToProject(t.db, userA, { kind, id: mine[otherKind] }, mineProject.id))).toEqual(missing);
      expect(await everything(t)).toEqual(before);

      // Positive control: my item into my project.
      await expect(saveToProject(t.db, userA, { kind, id: mine[kind] }, mineProject.id)).resolves.toMatchObject({
        itemIds: [mine[kind]],
      });
    });
  }

  it("a guest can save nothing — no project is ever a guest's — and a user cannot save a guest's still-expiring document", async () => {
    const project = await createProject(t.db, userA, { name: "a's" });
    const guestDocument = await insertDocument(t, guestA, new Date(Date.now() + 3_600_000));
    const before = await everything(t);
    const missing = await notFound(saveToProject(t.db, userA, { kind: "document", id: MISSING_ID }, project.id));

    expect(await notFound(saveToProject(t.db, guestA, { kind: "document", id: guestDocument.id }, project.id))).toEqual(missing);
    expect(await notFound(saveToProject(t.db, userA, { kind: "document", id: guestDocument.id }, project.id))).toEqual(missing);
    expect(await everything(t)).toEqual(before);
  });

  it("a draft chain holding any revision that is not the caller's is NOT_FOUND as a whole, with no partial save", async () => {
    const project = await createProject(t.db, userA, { name: "a's" });
    const chain = await insertDraftChain(t, userA, null, null, 2);
    // Malformed on purpose: a revision of B's hanging off A's chain.
    const [foreignRevision] = await t.db
      .insert(schema.drafts)
      .values({
        ownerUserId: USER_B_ID,
        documentType: "leave_and_license",
        mode: "from_scratch",
        content: "b's",
        revisionNumber: 3,
        parentDraftId: chain[1].id,
        modelUsed: "gemini-test",
      })
      .returning();
    const before = await everything(t);
    const missing = await notFound(saveToProject(t.db, userA, { kind: "draft", id: MISSING_ID }, project.id));

    expect(await notFound(saveToProject(t.db, userA, { kind: "draft", id: chain[0].id }, project.id))).toEqual(missing);
    expect(await notFound(saveToProject(t.db, userB, { kind: "draft", id: foreignRevision.id }, project.id))).toEqual(missing);
    expect(await everything(t)).toEqual(before);

    // Positive control: without the foreign revision the same chain saves whole.
    await t.client.query("DELETE FROM drafts WHERE id = $1", [foreignRevision.id]);
    const saved = await saveToProject(t.db, userA, { kind: "draft", id: chain[0].id }, project.id);
    expect(saved.itemIds.sort()).toEqual(chain.map((d) => d.id).sort());
  });
});
