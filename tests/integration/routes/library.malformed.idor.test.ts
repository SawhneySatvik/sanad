import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import * as comparisons from "@/app/api/comparisons/route";
import * as comparison from "@/app/api/comparisons/[id]/route";
import * as comparisonProject from "@/app/api/comparisons/[id]/project/route";
import * as drafts from "@/app/api/drafts/route";
import * as draft from "@/app/api/drafts/[id]/route";
import * as documents from "@/app/api/documents/route";
import * as document from "@/app/api/documents/[id]/route";
import * as documentProject from "@/app/api/documents/[id]/project/route";
import * as project from "@/app/api/projects/[id]/route";
import * as deleteAll from "@/app/api/me/data/route";
import { insertComparison, insertDocument } from "@tests/support/auth/claim";
import { callRoute, createRouteHarness, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => { h = await createRouteHarness(); h.signIn(userA); });
afterEach(async () => { await h.close(); });

const get = (handler: Parameters<typeof callRoute>[0], path: string, id?: string) =>
  callRoute(handler, request("GET", path), id ? { id } : {});

describe("malformed library relationships fail closed", () => {
  it("omits comparison rows with a foreign document on either side and still advances the cursor", async () => {
    const ownedA = await insertDocument(h.t, userA, null);
    const ownedB = await insertDocument(h.t, userA, null);
    const foreign = await insertDocument(h.t, userB, null);
    const valid = await Promise.all([
      insertComparison(h.t, userA, ownedA.id, ownedB.id, null),
      insertComparison(h.t, userA, ownedB.id, ownedA.id, null),
    ]);
    const malformed = await Promise.all([
      insertComparison(h.t, userA, foreign.id, ownedB.id, null),
      insertComparison(h.t, userA, ownedA.id, foreign.id, null),
    ]);
    for (const [index, row] of [...valid, ...malformed].entries()) {
      await h.t.db.update(schema.comparisons).set({ updatedAt: new Date(Date.now() + index * 1000) })
        .where(eq(schema.comparisons.id, row.id));
    }
    const first = await (await get(comparisons.GET, "/api/comparisons?limit=1")).json();
    const second = await (await get(comparisons.GET, `/api/comparisons?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(new Set([...first.items, ...second.items].map((row: { id: string }) => row.id)))
      .toEqual(new Set(valid.map((row) => row.id)));
    expect(second.nextCursor).toBeNull();
    for (const row of malformed) expect((await get(comparison.GET, `/api/comparisons/${row.id}`, row.id)).status).toBe(404);
  });

  it("omits a comparison that outlives an expired referenced document", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userA, null);
    const malformed = await insertComparison(h.t, userA, a.id, b.id, null);
    await h.t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.documents.id, b.id));
    expect((await (await get(comparisons.GET, "/api/comparisons")).json()).items).toEqual([]);
    expect((await get(comparison.GET, `/api/comparisons/${malformed.id}`, malformed.id)).status).toBe(404);
  });

  it("hides a comparison when either referenced document belongs to a foreign project", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userA, null);
    const c = await insertDocument(h.t, userA, null);
    const valid = await Promise.all([
      insertComparison(h.t, userA, b.id, c.id, null),
      insertComparison(h.t, userA, c.id, b.id, null),
    ]);
    const malformed = await Promise.all([
      insertComparison(h.t, userA, b.id, a.id, null),
      insertComparison(h.t, userA, a.id, b.id, null),
    ]);
    const [foreignProject] = await h.t.db.insert(schema.projects).values({ ownerUserId: userB.userId, name: "Foreign" }).returning();
    await h.t.db.update(schema.documents).set({ projectId: foreignProject.id }).where(eq(schema.documents.id, a.id));
    for (const row of malformed) await h.t.db.update(schema.comparisons).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(schema.comparisons.id, row.id));
    const before = (await h.t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, malformed[0].id)))[0];
    const first = await (await get(comparisons.GET, "/api/comparisons?limit=1")).json();
    const second = await (await get(comparisons.GET, `/api/comparisons?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(new Set([...first.items, ...second.items].map((row: { id: string }) => row.id)))
      .toEqual(new Set(valid.map((row) => row.id)));
    expect(second.nextCursor).toBeNull();
    for (const row of malformed) expect((await get(comparison.GET, `/api/comparisons/${row.id}`, row.id)).status).toBe(404);
    expect((await callRoute(comparison.PATCH, request("PATCH", `/api/comparisons/${malformed[0].id}`, { json: { title: "changed" } }), { id: malformed[0].id })).status).toBe(404);
    expect((await h.t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, malformed[0].id)))[0])
      .toMatchObject({ title: before.title, projectId: before.projectId, updatedAt: before.updatedAt });
  });

  it("hides a draft chain when an ancestor or grounding document has a foreign project", async () => {
    const [foreignProject] = await h.t.db.insert(schema.projects).values({ ownerUserId: userB.userId, name: "Foreign" }).returning();
    const grounding = await insertDocument(h.t, userA, null);
    const values = { ownerUserId: userA.userId, documentType: "leave_and_license" as const,
      mode: "document_grounded" as const, groundingDocumentId: grounding.id,
      content: "draft", modelUsed: "fake" };
    const [root] = await h.t.db.insert(schema.drafts).values({ ...values, revisionNumber: 1 }).returning();
    const [child] = await h.t.db.insert(schema.drafts).values({ ...values, revisionNumber: 2, parentDraftId: root.id }).returning();
    await h.t.db.update(schema.drafts).set({ projectId: foreignProject.id }).where(eq(schema.drafts.id, root.id));
    expect((await get(draft.GET, `/api/drafts/${child.id}`, child.id)).status).toBe(404);
    expect((await (await get(drafts.GET, "/api/drafts")).json()).items).toEqual([]);
    await h.t.db.update(schema.drafts).set({ projectId: null }).where(eq(schema.drafts.id, root.id));
    await h.t.db.update(schema.drafts).set({ projectId: foreignProject.id }).where(eq(schema.drafts.id, child.id));
    expect((await get(draft.GET, `/api/drafts/${root.id}`, root.id)).status).toBe(404);
    expect((await (await get(drafts.GET, "/api/drafts")).json()).items).toEqual([]);
    await h.t.db.update(schema.drafts).set({ projectId: null }).where(eq(schema.drafts.id, child.id));
    await h.t.db.update(schema.documents).set({ projectId: foreignProject.id }).where(eq(schema.documents.id, grounding.id));
    expect((await get(draft.GET, `/api/drafts/${child.id}`, child.id)).status).toBe(404);
    expect((await callRoute(draft.DELETE, request("DELETE", `/api/drafts/${child.id}`), { id: child.id })).status).toBe(404);
    expect((await (await get(drafts.GET, "/api/drafts")).json()).items).toEqual([]);
    expect(await h.t.db.select().from(schema.drafts)).toHaveLength(2);
  });

  it("omits documents assigned to a foreign project without losing later valid rows", async () => {
    const [foreignProject] = await h.t.db.insert(schema.projects).values({ ownerUserId: userB.userId, name: "Foreign" }).returning();
    const valid = await Promise.all([insertDocument(h.t, userA, null), insertDocument(h.t, userA, null)]);
    const malformed = await insertDocument(h.t, userA, null);
    await h.t.db.update(schema.documents).set({ projectId: foreignProject.id, updatedAt: new Date(Date.now() + 5000) })
      .where(eq(schema.documents.id, malformed.id));
    const first = await (await get(documents.GET, "/api/documents?limit=1")).json();
    const second = await (await get(documents.GET, `/api/documents?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(new Set([...first.items, ...second.items].map((row: { id: string }) => row.id)))
      .toEqual(new Set(valid.map((row) => row.id)));
    expect(second.nextCursor).toBeNull();
  });

  it("leaves titles, project IDs and timestamps untouched when a related row makes mutation a 404", async () => {
    const owned = await insertDocument(h.t, userA, null);
    const foreign = await insertDocument(h.t, userB, null);
    const malformedComparison = await insertComparison(h.t, userA, owned.id, foreign.id, null);
    const [foreignProject] = await h.t.db.insert(schema.projects).values({ ownerUserId: userB.userId, name: "Foreign" }).returning();
    await h.t.db.update(schema.documents).set({ projectId: foreignProject.id }).where(eq(schema.documents.id, owned.id));
    const [beforeDocument] = await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, owned.id));
    const [beforeComparison] = await h.t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, malformedComparison.id));
    expect((await callRoute(document.PATCH, request("PATCH", `/api/documents/${owned.id}`, { json: { title: "changed" } }), { id: owned.id })).status).toBe(404);
    expect((await callRoute(documentProject.DELETE, request("DELETE", `/api/documents/${owned.id}/project`), { id: owned.id })).status).toBe(404);
    expect((await callRoute(document.DELETE, request("DELETE", `/api/documents/${owned.id}`), { id: owned.id })).status).toBe(404);
    expect((await callRoute(comparison.PATCH, request("PATCH", `/api/comparisons/${malformedComparison.id}`, { json: { title: "changed" } }), { id: malformedComparison.id })).status).toBe(404);
    expect((await callRoute(comparisonProject.DELETE, request("DELETE", `/api/comparisons/${malformedComparison.id}/project`), { id: malformedComparison.id })).status).toBe(404);
    expect((await callRoute(comparison.DELETE, request("DELETE", `/api/comparisons/${malformedComparison.id}`), { id: malformedComparison.id })).status).toBe(404);
    const [afterDocument] = await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, owned.id));
    const [afterComparison] = await h.t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, malformedComparison.id));
    expect([afterDocument.title, afterDocument.projectId, afterDocument.updatedAt]).toEqual([
      beforeDocument.title, beforeDocument.projectId, beforeDocument.updatedAt,
    ]);
    expect([afterComparison.title, afterComparison.projectId, afterComparison.updatedAt]).toEqual([
      beforeComparison.title, beforeComparison.projectId, beforeComparison.updatedAt,
    ]);
  });

  it("hides a draft with foreign grounding or a foreign parent or child before deletion", async () => {
    const foreignDocument = await insertDocument(h.t, userB, null);
    const values = { documentType: "leave_and_license" as const, mode: "from_scratch" as const,
      content: "draft", revisionNumber: 1, modelUsed: "fake" };
    const [foreignRoot] = await h.t.db.insert(schema.drafts).values({ ...values, ownerUserId: userB.userId }).returning();
    const [foreignGrounding] = await h.t.db.insert(schema.drafts).values({ ...values, ownerUserId: userA.userId,
      mode: "document_grounded", groundingDocumentId: foreignDocument.id }).returning();
    const [foreignParent] = await h.t.db.insert(schema.drafts).values({ ...values, ownerUserId: userA.userId,
      revisionNumber: 2, parentDraftId: foreignRoot.id }).returning();
    const [ownedRoot] = await h.t.db.insert(schema.drafts).values({ ...values, ownerUserId: userA.userId }).returning();
    await h.t.db.insert(schema.drafts).values({ ...values, ownerUserId: userB.userId,
      revisionNumber: 2, parentDraftId: ownedRoot.id });
    for (const id of [foreignGrounding.id, foreignParent.id, ownedRoot.id]) {
      expect((await get(draft.GET, `/api/drafts/${id}`, id)).status).toBe(404);
      expect((await callRoute(draft.DELETE, request("DELETE", `/api/drafts/${id}`), { id })).status).toBe(404);
    }
    expect((await (await get(drafts.GET, "/api/drafts")).json()).items).toEqual([]);
    expect(await h.t.db.select().from(schema.drafts)).toHaveLength(5);
  });

  it("returns 404 for a project detail with foreign nested assignments", async () => {
    const [ownedProject] = await h.t.db.insert(schema.projects).values({ ownerUserId: userA.userId, name: "Owned" }).returning();
    const foreignDocument = await insertDocument(h.t, userB, null);
    await h.t.db.update(schema.documents).set({ projectId: ownedProject.id }).where(eq(schema.documents.id, foreignDocument.id));
    expect((await get(project.GET, `/api/projects/${ownedProject.id}`, ownedProject.id)).status).toBe(404);
  });

  it("delete-all returns 404 and changes nothing when an owned draft has a foreign child", async () => {
    const ownedDocument = await insertDocument(h.t, userA, null);
    const [root] = await h.t.db.insert(schema.drafts).values({ ownerUserId: userA.userId,
      documentType: "leave_and_license", mode: "from_scratch", content: "root",
      revisionNumber: 1, modelUsed: "fake" }).returning();
    await h.t.db.insert(schema.drafts).values({ ownerUserId: userB.userId,
      documentType: "leave_and_license", mode: "from_scratch", content: "foreign child",
      revisionNumber: 2, parentDraftId: root.id, modelUsed: "fake" });
    const response = await callRoute(deleteAll.DELETE, request("DELETE", "/api/me/data"));
    expect(response.status).toBe(404);
    expect(await h.t.db.select().from(schema.drafts)).toHaveLength(2);
    expect(await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, ownedDocument.id))).toHaveLength(1);
    expect(await h.t.db.select().from(schema.storageCleanupOutbox)).toHaveLength(0);
  });

  it("document deletion preserves a malformed dependent comparison", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userA, null);
    const dependent = await insertComparison(h.t, userA, a.id, b.id, null);
    const [foreignProject] = await h.t.db.insert(schema.projects).values({ ownerUserId: userB.userId, name: "Foreign" }).returning();
    await h.t.db.update(schema.comparisons).set({ projectId: foreignProject.id }).where(eq(schema.comparisons.id, dependent.id));
    expect((await callRoute(document.DELETE, request("DELETE", `/api/documents/${a.id}`), { id: a.id })).status).toBe(404);
    expect(await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, a.id))).toHaveLength(1);
    expect(await h.t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, dependent.id))).toHaveLength(1);
    expect(await h.t.db.select().from(schema.storageCleanupOutbox)).toHaveLength(0);
  });
});
