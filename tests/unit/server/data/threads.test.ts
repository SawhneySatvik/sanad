import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { attachDocument, createThread, deleteThread, getThread, listThreads, renameThread } from "@/server/data/threads";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const principalA: Principal = { type: "user", userId: USER_A };
const principalB: Principal = { type: "user", userId: USER_B };
const guestPrincipal: Principal = { type: "guest", guestSessionId: "guest-session-aaaa" };

let t: TestDb;
let storageRefCounter = 0;

beforeEach(async () => {
  t = await createTestDb();
  storageRefCounter = 0;
  await t.db.insert(schema.users).values([
    { id: USER_A, email: "a@example.com" },
    { id: USER_B, email: "b@example.com" },
  ]);
});
afterEach(async () => {
  await t.close();
});

async function insertProject(ownerUserId: string): Promise<string> {
  const [row] = await t.db.insert(schema.projects).values({ ownerUserId, name: "Test project" }).returning();
  return row.id;
}

async function insertDocument(owner: { ownerUserId?: string; ownerGuestSessionId?: string }): Promise<string> {
  storageRefCounter += 1;
  const [row] = await t.db
    .insert(schema.documents)
    .values({
      ownerUserId: owner.ownerUserId ?? null,
      ownerGuestSessionId: owner.ownerGuestSessionId ?? null,
      storageRef: `ref-${storageRefCounter}`,
      filename: "lease.pdf",
      mimeType: "application/pdf",
    })
    .returning();
  return row.id;
}

describe("createThread", () => {
  it("a user principal can create a thread (positive control)", async () => {
    const thread = await createThread(t.db, principalA, { title: "My thread" });
    expect(thread.ownerUserId).toBe(USER_A);
    expect(thread.title).toBe("My thread");
  });

  it("a guest principal is refused with a VALIDATION_FAILED-shaped AppError — guest threads never get a DB row", async () => {
    let caught: unknown;
    try {
      await createThread(t.db, guestPrincipal, { title: "Guest thread" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("VALIDATION_FAILED");

    const rows = await t.db.select().from(schema.threads);
    expect(rows).toHaveLength(0);
  });

  it("creating a thread scoped to a project the principal owns succeeds", async () => {
    const projectId = await insertProject(USER_A);
    const thread = await createThread(t.db, principalA, { title: "Scoped", projectId });
    expect(thread.projectId).toBe(projectId);
  });

  it("IDOR: creating a thread scoped to another user's project throws NOT_FOUND (multi-entity rule) — no thread row is created", async () => {
    const foreignProjectId = await insertProject(USER_B);
    let caught: unknown;
    try {
      await createThread(t.db, principalA, { title: "Scoped", projectId: foreignProjectId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
    const rows = await t.db.select().from(schema.threads);
    expect(rows).toHaveLength(0);
  });

  it("creating a thread scoped to a nonexistent project throws NOT_FOUND, identically to a foreign one", async () => {
    await expect(
      createThread(t.db, principalA, { title: "Scoped", projectId: "99999999-9999-9999-9999-999999999999" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a malformed (non-UUID) projectId throws NOT_FOUND, not a raw Postgres 500 — never a 404-vs-500 existence oracle", async () => {
    await expect(
      createThread(t.db, principalA, { title: "Scoped", projectId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("getThread — IDOR", () => {
  it("the owning principal can read its own thread (positive control)", async () => {
    const created = await createThread(t.db, principalA, { title: "Mine" });
    const fetched = await getThread(t.db, principalA, created.id);
    expect(fetched.id).toBe(created.id);
  });

  it("a foreign principal gets NOT_FOUND reading another user's thread", async () => {
    const created = await createThread(t.db, principalA, { title: "Mine" });
    await expect(getThread(t.db, principalB, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a missing thread id gets NOT_FOUND, identically to a foreign one", async () => {
    await expect(
      getThread(t.db, principalA, "99999999-9999-9999-9999-999999999999"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a malformed (non-UUID) thread id gets NOT_FOUND, not a raw Postgres 500 — never a 404-vs-500 existence oracle", async () => {
    await expect(getThread(t.db, principalA, "not-a-uuid")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("renameThread — IDOR", () => {
  it("the owning principal can rename its own thread (positive control)", async () => {
    const created = await createThread(t.db, principalA, { title: "Old" });
    const renamed = await renameThread(t.db, principalA, created.id, "New");
    expect(renamed.title).toBe("New");
  });

  it("a foreign principal gets NOT_FOUND renaming another user's thread, and the title is unchanged", async () => {
    const created = await createThread(t.db, principalA, { title: "Old" });
    await expect(renameThread(t.db, principalB, created.id, "Hijacked")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const stillOld = await getThread(t.db, principalA, created.id);
    expect(stillOld.title).toBe("Old");
  });

  // A thread deleted between renameThread's own getThread() check and its UPDATE (a genuine
  // concurrent-request race, not an IDOR) must 404 like every disappearing-thread path, never
  // return `undefined` typed as `Thread`. PGlite's single connection makes this interleave for real.
  it("a thread deleted concurrently with renameThread's UPDATE returns NOT_FOUND, never an undefined Thread", async () => {
    const created = await createThread(t.db, principalA, { title: "Old" });
    const [renameResult] = await Promise.allSettled([
      renameThread(t.db, principalA, created.id, "New"),
      t.db.delete(schema.threads).where(eq(schema.threads.id, created.id)),
    ]);
    expect(renameResult.status).toBe("rejected");
    if (renameResult.status === "rejected") {
      expect(renameResult.reason).toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("deleteThread — IDOR", () => {
  it("a foreign principal gets NOT_FOUND deleting another user's thread, and the row survives (positive control follows)", async () => {
    const created = await createThread(t.db, principalA, { title: "Mine" });
    await expect(deleteThread(t.db, principalB, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stillThere = await getThread(t.db, principalA, created.id);
    expect(stillThere.id).toBe(created.id);
  });

  it("the owning principal can delete its own thread", async () => {
    const created = await createThread(t.db, principalA, { title: "Mine" });
    await deleteThread(t.db, principalA, created.id);
    await expect(getThread(t.db, principalA, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listThreads", () => {
  it("returns only the calling principal's own threads, newest-updated first", async () => {
    await createThread(t.db, principalA, { title: "A1" });
    await createThread(t.db, principalB, { title: "B1" });
    const mine = await listThreads(t.db, principalA);
    expect(mine.map((th) => th.title)).toEqual(["A1"]);
  });

  it("filters by projectId when given", async () => {
    const projectId = await insertProject(USER_A);
    await createThread(t.db, principalA, { title: "Scoped", projectId });
    await createThread(t.db, principalA, { title: "Unscoped" });
    const scoped = await listThreads(t.db, principalA, { projectId });
    expect(scoped.map((th) => th.title)).toEqual(["Scoped"]);
  });

  it("a guest principal always gets an empty list — no thread row can ever be guest-owned", async () => {
    await createThread(t.db, principalA, { title: "A1" });
    expect(await listThreads(t.db, guestPrincipal)).toEqual([]);
  });

  // A malformed (non-UUID) projectId filter must 404-shaped-empty like every other
  // client-suppliable id in this repository, never reach Postgres and 500.
  it("a malformed (non-UUID) projectId filter returns [] rather than a raw Postgres 500", async () => {
    await createThread(t.db, principalA, { title: "A1" });
    expect(await listThreads(t.db, principalA, { projectId: "not-a-uuid" })).toEqual([]);
  });

  // Two threads tied on updated_at must still sort deterministically via the id DESC tie-break. This
  // asserts the actual id-descending order (derived from the two real ids), not an assumption of
  // which one "should" win, so it fails if the tie-break term is ever dropped or reversed.
  it("two threads tied on updated_at sort deterministically by id DESC", async () => {
    const t1 = await createThread(t.db, principalA, { title: "First" });
    const t2 = await createThread(t.db, principalA, { title: "Second" });
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    await t.db.update(schema.threads).set({ updatedAt: sameInstant }).where(eq(schema.threads.id, t1.id));
    await t.db.update(schema.threads).set({ updatedAt: sameInstant }).where(eq(schema.threads.id, t2.id));

    const listed = await listThreads(t.db, principalA);
    const expectedOrder = [t1, t2].sort((a, b) => (a.id > b.id ? -1 : 1)).map((th) => th.title);
    expect(listed.map((th) => th.title)).toEqual(expectedOrder);
  });
});

describe("attachDocument — multi-entity IDOR rule", () => {
  it("the principal owning BOTH the thread and the document succeeds (positive control)", async () => {
    const thread = await createThread(t.db, principalA, { title: "Mine" });
    const documentId = await insertDocument({ ownerUserId: USER_A });
    await attachDocument(t.db, principalA, thread.id, documentId);
    const rows = await t.db
      .select()
      .from(schema.threadDocuments)
      .where(eq(schema.threadDocuments.threadId, thread.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].documentId).toBe(documentId);
  });

  it("IDOR: attaching user B's document to user A's own thread throws NOT_FOUND, and nothing is attached", async () => {
    const thread = await createThread(t.db, principalA, { title: "Mine" });
    const foreignDocumentId = await insertDocument({ ownerUserId: USER_B });
    await expect(attachDocument(t.db, principalA, thread.id, foreignDocumentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const rows = await t.db
      .select()
      .from(schema.threadDocuments)
      .where(eq(schema.threadDocuments.threadId, thread.id));
    expect(rows).toHaveLength(0);
  });

  it("IDOR: attaching to user B's thread (using user A's own document) throws NOT_FOUND — the primary entity is checked too, not only the associated one", async () => {
    const foreignThread = await createThread(t.db, principalB, { title: "Not mine" });
    const documentId = await insertDocument({ ownerUserId: USER_A });
    await expect(attachDocument(t.db, principalA, foreignThread.id, documentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("attaching a document to a nonexistent thread throws NOT_FOUND, identically to a foreign one", async () => {
    const documentId = await insertDocument({ ownerUserId: USER_A });
    await expect(
      attachDocument(t.db, principalA, "99999999-9999-9999-9999-999999999999", documentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a malformed (non-UUID) threadId or documentId throws NOT_FOUND, not a raw Postgres 500", async () => {
    const thread = await createThread(t.db, principalA, { title: "Mine" });
    const documentId = await insertDocument({ ownerUserId: USER_A });
    await expect(attachDocument(t.db, principalA, "not-a-uuid", documentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(attachDocument(t.db, principalA, thread.id, "not-a-uuid")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
