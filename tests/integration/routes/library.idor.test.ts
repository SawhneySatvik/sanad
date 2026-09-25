import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@/db/ids";
import * as schema from "@/db/schema";
import * as documents from "@/app/api/documents/route";
import * as document from "@/app/api/documents/[id]/route";
import * as impact from "@/app/api/documents/[id]/delete-impact/route";
import * as documentProject from "@/app/api/documents/[id]/project/route";
import * as comparisons from "@/app/api/comparisons/route";
import * as comparison from "@/app/api/comparisons/[id]/route";
import * as comparisonProject from "@/app/api/comparisons/[id]/project/route";
import * as drafts from "@/app/api/drafts/route";
import * as draft from "@/app/api/drafts/[id]/route";
import * as revisions from "@/app/api/drafts/[id]/revisions/route";
import * as draftProject from "@/app/api/drafts/[id]/project/route";
import * as threads from "@/app/api/threads/route";
import * as thread from "@/app/api/threads/[id]/route";
import * as threadProject from "@/app/api/threads/[id]/project/route";
import * as project from "@/app/api/projects/[id]/route";
import * as deleteAll from "@/app/api/me/data/route";
import { insertComparison, insertDocument, insertDraftChain } from "@tests/support/auth/claim";
import { callRoute, createRouteHarness, FIXED_CLOCK, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => { h = await createRouteHarness(); h.signIn(userA); });
afterEach(async () => { vi.unstubAllEnvs(); await h.close(); });

const call = (handler: Parameters<typeof callRoute>[0], method: string, path: string, id?: string, json?: unknown) =>
  callRoute(handler, request(method, path, { json }), id ? { id } : {});

describe("library owner boundaries", () => {
  it("excludes foreign rows and returns indistinguishable 404s on every owner-only action", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userB, null);
    const b2 = await insertDocument(h.t, userB, null);
    const c = await insertComparison(h.t, userB, b.id, b2.id, null);
    const d = (await insertDraftChain(h.t, userB, null, null, 1))[0];
    const [t] = await h.t.db.insert(schema.threads).values({ ownerUserId: userB.userId, title: "b" }).returning();
    const [p] = await h.t.db.insert(schema.projects).values({ ownerUserId: userB.userId, name: "b" }).returning();
    expect((await (await call(documents.GET, "GET", "/api/documents")).json()).items.map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect((await (await call(comparisons.GET, "GET", "/api/comparisons")).json()).items).toEqual([]);
    expect((await (await call(drafts.GET, "GET", "/api/drafts")).json()).items).toEqual([]);
    expect((await (await call(threads.GET, "GET", "/api/threads")).json()).items).toEqual([]);
    const cases = [
      [document.PATCH, document.DELETE, b.id, "/api/documents"],
      [comparison.PATCH, comparison.DELETE, c.id, "/api/comparisons"],
      [draft.PATCH, draft.DELETE, d.id, "/api/drafts"],
      [thread.PATCH, thread.DELETE, t.id, "/api/threads"],
      [project.PATCH, project.DELETE, p.id, "/api/projects"],
    ] as const;
    for (const [patch, remove, id, base] of cases) {
      const foreign = await call(patch, "PATCH", `${base}/${id}`, id, base === "/api/projects" ? { name: "x" } : { title: "x" });
      const missing = await call(patch, "PATCH", `${base}/00000000-0000-4000-8000-000000000000`, "00000000-0000-4000-8000-000000000000", base === "/api/projects" ? { name: "x" } : { title: "x" });
      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe(await missing.text());
      expect((await call(remove, "DELETE", `${base}/${id}`, id)).status).toBe(404);
    }
    expect((await call(impact.GET, "GET", `/api/documents/${b.id}/delete-impact`, b.id)).status).toBe(404);
    expect((await call(revisions.GET, "GET", `/api/drafts/${d.id}/revisions`, d.id)).status).toBe(404);
    expect((await call(documentProject.DELETE, "DELETE", `/api/documents/${b.id}/project`, b.id)).status).toBe(404);
    expect((await call(comparisonProject.DELETE, "DELETE", `/api/comparisons/${c.id}/project`, c.id)).status).toBe(404);
    expect((await call(draftProject.DELETE, "DELETE", `/api/drafts/${d.id}/project`, d.id)).status).toBe(404);
    expect((await call(threadProject.DELETE, "DELETE", `/api/threads/${t.id}/project`, t.id)).status).toBe(404);
  });

  it("cleans rename titles and applies the document and project length caps", async () => {
    const d = await insertDocument(h.t, userA, null);
    const [p] = await h.t.db.insert(schema.projects).values({ ownerUserId: userA.userId, name: "Matter" }).returning();
    const renamed = await call(document.PATCH, "PATCH", `/api/documents/${d.id}`, d.id, { title: "  New\u202e title\n" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("New title");
    expect((await call(document.PATCH, "PATCH", `/api/documents/${d.id}`, d.id, { title: "x".repeat(121) })).status).toBe(400);
    const projectRename = await call(project.PATCH, "PATCH", `/api/projects/${p.id}`, p.id, { name: "p".repeat(255) });
    expect(projectRename.status).toBe(200);
    expect((await call(project.PATCH, "PATCH", `/api/projects/${p.id}`, p.id, { name: "p".repeat(256) })).status).toBe(400);
  });

  it("pages by updatedAt and id without repeats", async () => {
    const rows = await Promise.all(Array.from({ length: 3 }, () => insertDocument(h.t, userA, null)));
    const instant = new Date("2026-09-24T12:00:00Z");
    await h.t.db.update(schema.documents).set({ updatedAt: instant }).where(eq(schema.documents.ownerUserId, userA.userId));
    const first = await (await call(documents.GET, "GET", "/api/documents?limit=2")).json();
    const second = await (await call(documents.GET, "GET", `/api/documents?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((r: { id: string }) => r.id))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it("keeps PostgreSQL microseconds in the cursor", async () => {
    const rows = await Promise.all(Array.from({ length: 3 }, () => insertDocument(h.t, userA, null)));
    for (const [index, row] of rows.entries()) {
      await h.t.client.query("UPDATE documents SET updated_at = $1::timestamptz WHERE id = $2", [`2026-09-24 12:00:00.12345${6 - index}+00`, row.id]);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const body: { items: Array<{ id: string }>; nextCursor: string | null } = await (await call(documents.GET, "GET", `/api/documents?limit=1${suffix}`)).json();
      seen.push(...body.items.map((row: { id: string }) => row.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(rows.map((row) => row.id));
  });

  it("rejects a forged cursor whose timestamp is not a database timestamp", async () => {
    const id = "a1a1a1a1-0000-4000-8000-0000000000a1";
    const forged = Buffer.from(JSON.stringify(["0", id])).toString("base64url");
    expect((await call(documents.GET, "GET", `/api/documents?cursor=${forged}`)).status).toBe(400);
    const impossible = Buffer.from(JSON.stringify(["2026-02-30T12:00:00Z", id])).toString("base64url");
    expect((await call(documents.GET, "GET", `/api/documents?cursor=${impossible}`)).status).toBe(400);
    for (const outOfRange of ["0000-01-01T00:00:00Z", "2026-01-01T00:00:00+16:00", "2026-01-01T00:00:00-16:00", "2026-01-01T00:00:00+15:60"]) {
      const cursor = Buffer.from(JSON.stringify([outOfRange, id])).toString("base64url");
      expect((await call(documents.GET, "GET", `/api/documents?cursor=${cursor}`)).status, outOfRange).toBe(400);
    }
    const edge = Buffer.from(JSON.stringify(["2026-01-01T00:00:00+15:59", id])).toString("base64url");
    expect((await call(documents.GET, "GET", `/api/documents?cursor=${edge}`)).status).toBe(200);
  });

  it("pages draft chains by their latest revision and updatedAt without repeating a branch", async () => {
    const chains = await Promise.all(Array.from({ length: 3 }, () => insertDraftChain(h.t, userA, null, null, 2)));
    const instant = new Date("2026-09-24T12:00:00Z");
    await h.t.db.update(schema.drafts).set({ updatedAt: instant }).where(eq(schema.drafts.ownerUserId, userA.userId));
    const first = await (await call(drafts.GET, "GET", "/api/drafts?limit=2")).json();
    const second = await (await call(drafts.GET, "GET", `/api/drafts?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row: { id: string }) => row.id))).toEqual(new Set(chains.map((chain) => chain[1].id)));
    expect([...first.items, ...second.items].every((row: { revisionCount: number }) => row.revisionCount === 2)).toBe(true);
  });

  it("orders draft revisions with database timestamp precision", async () => {
    const chain = await insertDraftChain(h.t, userA, null, null, 2);
    const later = [...chain].sort((a, b) => a.id.localeCompare(b.id))[0];
    const earlier = chain.find((row) => row.id !== later.id)!;
    await h.t.client.query("UPDATE drafts SET created_at = $1::timestamptz WHERE id = $2", ["2026-09-24 12:00:00.123456+00", later.id]);
    await h.t.client.query("UPDATE drafts SET created_at = $1::timestamptz WHERE id = $2", ["2026-09-24 12:00:00.123455+00", earlier.id]);
    const timeline = await (await call(revisions.GET, "GET", `/api/drafts/${earlier.id}/revisions`, earlier.id)).json();
    expect(timeline.items.map((row: { id: string }) => row.id)).toEqual([earlier.id, later.id]);
    expect(timeline.items.map((row: { isLatest: boolean }) => row.isLatest)).toEqual([false, true]);
    const listed = await (await call(drafts.GET, "GET", "/api/drafts")).json();
    expect(listed.items[0].id).toBe(later.id);
  });

  it("renames a whole draft chain and marks current and latest revisions", async () => {
    const chain = await insertDraftChain(h.t, userA, null, null, 3);
    for (const [index, row] of chain.entries()) await h.t.db.update(schema.drafts).set({ createdAt: new Date(Date.now() + index * 1000) }).where(eq(schema.drafts.id, row.id));
    const fixedPast = new Date("2020-01-01T00:00:00Z");
    await h.t.db.update(schema.drafts).set({ updatedAt: fixedPast }).where(eq(schema.drafts.ownerUserId, userA.userId));
    const renamed = await call(draft.PATCH, "PATCH", `/api/drafts/${chain[1].id}`, chain[1].id, { title: "  New name  " });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("New name");
    const stored = await h.t.db.select().from(schema.drafts);
    expect(stored.map((row) => row.title)).toEqual(["New name", "New name", "New name"]);
    expect(stored.every((row) => row.updatedAt.getTime() > fixedPast.getTime())).toBe(true);
    const timeline = await (await call(revisions.GET, "GET", `/api/drafts/${chain[1].id}/revisions`, chain[1].id)).json();
    expect(timeline.items.map((row: { isCurrent: boolean; isLatest: boolean }) => [row.isCurrent, row.isLatest])).toEqual([[false, false], [true, false], [false, true]]);
    const unassigned = await call(draftProject.DELETE, "DELETE", `/api/drafts/${chain[1].id}/project`, chain[1].id);
    expect(unassigned.status).toBe(200);
    expect((await unassigned.json()).projectId).toBeNull();
  });

  it("orders a branched revision chain by creation and identifies its latest leaf", async () => {
    const chain = await insertDraftChain(h.t, userA, null, null, 2);
    for (const [index, row] of chain.entries()) await h.t.db.update(schema.drafts).set({ createdAt: new Date(Date.now() + index * 1000) }).where(eq(schema.drafts.id, row.id));
    const [branch] = await h.t.db.insert(schema.drafts).values({ ownerUserId: userA.userId,
      documentType: "leave_and_license", mode: "from_scratch", content: "branch", revisionNumber: 2,
      parentDraftId: chain[0].id, modelUsed: "gemini-test", createdAt: new Date(Date.now() + 3000) }).returning();
    const response = await call(revisions.GET, "GET", `/api/drafts/${chain[1].id}/revisions`, chain[1].id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((row: { id: string }) => row.id)).toEqual([chain[0].id, chain[1].id, branch.id]);
    expect(body.items.map((row: { isCurrent: boolean; isLatest: boolean }) => [row.isCurrent, row.isLatest])).toEqual([[false, false], [true, false], [false, true]]);
    const listed = await (await call(drafts.GET, "GET", "/api/drafts")).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].id).toBe(branch.id);
    expect(listed.items[0].revisionCount).toBe(3);
  });

  it("deletes a branch and its complete draft chain leaf first", async () => {
    const chain = await insertDraftChain(h.t, userA, null, null, 3);
    const [branch] = await h.t.db.insert(schema.drafts).values({ ownerUserId: userA.userId,
      documentType: "leave_and_license", mode: "from_scratch", content: "branch", revisionNumber: 2,
      parentDraftId: chain[0].id, modelUsed: "gemini-test" }).returning();
    const response = await call(draft.DELETE, "DELETE", `/api/drafts/${chain[1].id}`, chain[1].id);
    expect(response.status).toBe(204);
    expect(await h.t.db.select().from(schema.drafts)).toHaveLength(0);
    expect(branch.id).not.toBe(chain[1].id);
  });

  it("deletes comparisons and threads through their cascading child references", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userA, null);
    const c = await insertComparison(h.t, userA, a.id, b.id, null);
    await h.t.db.insert(schema.comparisonChanges).values({ comparisonId: c.id, changeType: "added", explanation: "change" });
    expect((await call(comparison.DELETE, "DELETE", `/api/comparisons/${c.id}`, c.id)).status).toBe(204);
    expect(await h.t.db.select().from(schema.comparisonChanges)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.documents)).toHaveLength(2);
    const [t] = await h.t.db.insert(schema.threads).values({ ownerUserId: userA.userId, title: "chat" }).returning();
    await h.t.db.insert(schema.threadDocuments).values({ threadId: t.id, documentId: a.id });
    expect((await call(thread.DELETE, "DELETE", `/api/threads/${t.id}`, t.id)).status).toBe(204);
    expect(await h.t.db.select().from(schema.threadDocuments)).toHaveLength(0);
  });

  it("deletes a project by unassigning items and preserving their expiry", async () => {
    const expiresAt = new Date(Date.now() + 3600000);
    const d = await insertDocument(h.t, userA, expiresAt);
    const [p] = await h.t.db.insert(schema.projects).values({ ownerUserId: userA.userId, name: "project" }).returning();
    await h.t.db.update(schema.documents).set({ projectId: p.id }).where(eq(schema.documents.id, d.id));
    expect((await call(project.DELETE, "DELETE", `/api/projects/${p.id}`, p.id)).status).toBe(204);
    const [remaining] = await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, d.id));
    expect(remaining.projectId).toBeNull();
    expect(remaining.expiresAt).toEqual(expiresAt);
  });

  it("deletes a document's comparisons and ungrounds its drafts", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userA, null);
    await insertComparison(h.t, userA, a.id, b.id, null);
    const chain = await insertDraftChain(h.t, userA, null, a.id, 2);
    const [analysis] = await h.t.db.insert(schema.analyses).values({ documentId: a.id, promptVersion: "test", modelUsed: "fake" }).returning();
    const [finding] = await h.t.db.insert(schema.findings).values({ documentId: a.id, analysisId: analysis.id,
      category: "missing_clause", modelUsed: "fake", explanation: "fixture" }).returning();
    await h.t.db.insert(schema.findingLensExplanations).values({ findingId: finding.id, roleStageLens: "tenant_about_to_sign", explanation: "fixture" });
    const [t] = await h.t.db.insert(schema.threads).values({ ownerUserId: userA.userId, title: "chat" }).returning();
    await h.t.db.insert(schema.threadDocuments).values({ threadId: t.id, documentId: a.id });
    const messageId = newId();
    await h.t.db.insert(schema.messages).values({ id: messageId, threadId: t.id, role: "assistant", content: "answer", mode: "grounded", modelUsed: "fake" });
    await h.t.db.insert(schema.messageCitations).values({ messageId, quoteText: "quote", sourceDocumentId: a.id,
      verificationStatus: "not_found", verifierVersion: "test" });
    const impactResponse = await call(impact.GET, "GET", `/api/documents/${a.id}/delete-impact`, a.id);
    expect(await impactResponse.json()).toEqual({ comparisons: 1, draftsUngrounded: 2, threadsUnlinked: 1 });
    expect((await call(document.DELETE, "DELETE", `/api/documents/${a.id}`, a.id)).status).toBe(204);
    expect(await h.t.db.select().from(schema.comparisons)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.analyses)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.findings)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.findingLensExplanations)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.threadDocuments)).toHaveLength(0);
    expect((await h.t.db.select().from(schema.messageCitations))[0].sourceDocumentId).toBeNull();
    expect(await h.t.db.select().from(schema.messages)).toHaveLength(1);
    expect((await h.t.db.select().from(schema.drafts)).every((row) => row.groundingDocumentId === null)).toBe(true);
    expect((await h.t.db.select().from(schema.drafts)).map((row) => row.id)).toEqual(chain.map((row) => row.id));
  });

  it("hides expired guest details as well as list rows", async () => {
    h.signIn(null);
    const guest = guestCookie();
    const principal = { type: "guest" as const, guestSessionId: guest.guestSessionId };
    const a = await insertDocument(h.t, principal, new Date(Date.now() + 60_000));
    const b = await insertDocument(h.t, principal, new Date(Date.now() + 60_000));
    const c = await insertComparison(h.t, principal, a.id, b.id, new Date(Date.now() + 60_000));
    const expired = new Date(Date.now() - 60_000);
    await h.t.db.update(schema.comparisons).set({ expiresAt: expired }).where(eq(schema.comparisons.id, c.id));
    const guestCall = (handler: Parameters<typeof callRoute>[0], path: string, id?: string) =>
      callRoute(handler, request("GET", path, { cookie: guest.cookie }), id ? { id } : {});
    expect((await (await guestCall(comparisons.GET, "/api/comparisons")).json()).items).toEqual([]);
    expect((await guestCall(comparison.GET, `/api/comparisons/${c.id}`, c.id)).status).toBe(404);
    await h.t.db.update(schema.documents).set({ expiresAt: expired }).where(eq(schema.documents.id, a.id));
    expect((await (await guestCall(documents.GET, "/api/documents")).json()).items.map((row: { id: string }) => row.id)).toEqual([b.id]);
    expect((await guestCall(document.GET, `/api/documents/${a.id}`, a.id)).status).toBe(404);
  });

  it("refuses malformed cross-owner references before deleting a document", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userB, null);
    const [foreignComparison] = await h.t.db.insert(schema.comparisons).values({ ownerUserId: userB.userId,
      documentAId: a.id, documentBId: b.id, modelUsed: "fake" }).returning();
    const [foreignDraft] = await h.t.db.insert(schema.drafts).values({ ownerUserId: userB.userId,
      documentType: "leave_and_license", mode: "document_grounded", groundingDocumentId: a.id,
      content: "foreign", revisionNumber: 1, modelUsed: "fake" }).returning();
    const [foreignThread] = await h.t.db.insert(schema.threads).values({ ownerUserId: userB.userId, title: "foreign" }).returning();
    await h.t.db.insert(schema.threadDocuments).values({ threadId: foreignThread.id, documentId: a.id });
    const messageId = newId();
    await h.t.db.insert(schema.messages).values({ id: messageId, threadId: foreignThread.id, role: "assistant", content: "answer", mode: "grounded", modelUsed: "fake" });
    await h.t.db.insert(schema.messageCitations).values({ messageId, quoteText: "quote", sourceDocumentId: a.id,
      verificationStatus: "not_found", verifierVersion: "test" });
    expect((await call(impact.GET, "GET", `/api/documents/${a.id}/delete-impact`, a.id)).status).toBe(404);
    expect((await call(document.DELETE, "DELETE", `/api/documents/${a.id}`, a.id)).status).toBe(404);
    expect((await call(deleteAll.DELETE, "DELETE", "/api/me/data")).status).toBe(404);
    expect((await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, a.id)))).toHaveLength(1);
    expect((await h.t.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, foreignComparison.id)))).toHaveLength(1);
    expect((await h.t.db.select().from(schema.drafts).where(eq(schema.drafts.id, foreignDraft.id)))[0].groundingDocumentId).toBe(a.id);
    expect((await h.t.db.select().from(schema.threadDocuments).where(eq(schema.threadDocuments.documentId, a.id)))).toHaveLength(1);
    expect((await h.t.db.select().from(schema.messageCitations).where(eq(schema.messageCitations.messageId, messageId)))[0].sourceDocumentId).toBe(a.id);
    expect(await h.t.db.select().from(schema.storageCleanupOutbox)).toHaveLength(0);
  });

  it("refuses malformed cross-owner project assignments before deleting a project", async () => {
    const [ownedProject] = await h.t.db.insert(schema.projects).values({ ownerUserId: userA.userId, name: "Owned" }).returning();
    const foreignDocument = await insertDocument(h.t, userB, null);
    await h.t.db.update(schema.documents).set({ projectId: ownedProject.id }).where(eq(schema.documents.id, foreignDocument.id));
    const response = await call(project.DELETE, "DELETE", `/api/projects/${ownedProject.id}`, ownedProject.id);
    expect(response.status).toBe(404);
    expect((await call(deleteAll.DELETE, "DELETE", "/api/me/data")).status).toBe(404);
    expect((await h.t.db.select().from(schema.projects).where(eq(schema.projects.id, ownedProject.id)))).toHaveLength(1);
    expect((await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, foreignDocument.id)))[0].projectId).toBe(ownedProject.id);
    expect(await h.t.db.select().from(schema.storageCleanupOutbox)).toHaveLength(0);
  });

  it("deletes only the caller's complete data set and clears a guest cookie", async () => {
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userA, null);
    await insertComparison(h.t, userA, a.id, b.id, null);
    await insertDraftChain(h.t, userA, null, a.id, 2);
    await h.t.db.insert(schema.threads).values({ ownerUserId: userA.userId, title: "chat" });
    await h.t.db.insert(schema.projects).values({ ownerUserId: userA.userId, name: "Matter" });
    await insertDocument(h.t, userB, null);
    const response = await call(deleteAll.DELETE, "DELETE", "/api/me/data");
    expect(response.status).toBe(200);
    expect((await response.json()).deleted).toEqual({ documents: 2, comparisons: 1, drafts: 2, threads: 1, projects: 1 });
    expect((await h.t.db.select().from(schema.documents)).map((row) => row.ownerUserId)).toEqual([userB.userId]);
    expect(await h.t.db.select().from(schema.comparisons)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.drafts)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.threads)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.projects)).toHaveLength(0);
    h.signIn(null);
    const guest = guestCookie();
    const guestResponse = await callRoute(deleteAll.DELETE, request("DELETE", "/api/me/data", { cookie: guest.cookie }));
    expect(guestResponse.status).toBe(200);
    expect(guestResponse.headers.getSetCookie().some((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("unassigns an actually-project-owned document and whole draft chain, keeping expiry and returning the row", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const [p] = await h.t.db.insert(schema.projects).values({ ownerUserId: userA.userId, name: "Matter" }).returning();
    const d = await insertDocument(h.t, userA, expiresAt);
    await h.t.db.update(schema.documents).set({ projectId: p.id }).where(eq(schema.documents.id, d.id));
    const unassignedDoc = await call(documentProject.DELETE, "DELETE", `/api/documents/${d.id}/project`, d.id);
    expect(unassignedDoc.status).toBe(200);
    const docBody = await unassignedDoc.json();
    expect(docBody.id).toBe(d.id);
    expect(docBody.projectId).toBeNull();
    const [storedDoc] = await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, d.id));
    expect(storedDoc.projectId).toBeNull();
    expect(storedDoc.expiresAt).toEqual(expiresAt);

    const chain = await insertDraftChain(h.t, userA, expiresAt, null, 2);
    await h.t.db.update(schema.drafts).set({ projectId: p.id }).where(eq(schema.drafts.ownerUserId, userA.userId));
    const unassignedDraft = await call(draftProject.DELETE, "DELETE", `/api/drafts/${chain[0].id}/project`, chain[0].id);
    expect(unassignedDraft.status).toBe(200);
    const draftBody = await unassignedDraft.json();
    expect(draftBody.id).toBe(chain[0].id);
    expect(draftBody.projectId).toBeNull();
    const storedChain = await h.t.db.select().from(schema.drafts).where(eq(schema.drafts.ownerUserId, userA.userId));
    expect(storedChain.every((row) => row.projectId === null)).toBe(true);
    expect(storedChain.every((row) => row.expiresAt?.getTime() === expiresAt.getTime())).toBe(true);
  });

  it("charges the shared IP tier on each new route family", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    h.container.rateLimits.ipPerMinute = 1;
    h.container.rateLimits.clock = FIXED_CLOCK;
    const d = await insertDocument(h.t, userA, null);
    const chain = await insertDraftChain(h.t, userA, null, null, 1);
    const cases = [
      [documents.GET, "GET", "/api/documents", undefined, undefined],
      [comparisons.GET, "GET", "/api/comparisons", undefined, undefined],
      [drafts.GET, "GET", "/api/drafts", undefined, undefined],
      [threads.GET, "GET", "/api/threads", undefined, undefined],
      [document.PATCH, "PATCH", `/api/documents/${d.id}`, d.id, { title: "Renamed" }],
      [impact.GET, "GET", `/api/documents/${d.id}/delete-impact`, d.id, undefined],
      [revisions.GET, "GET", `/api/drafts/${chain[0].id}/revisions`, chain[0].id, undefined],
      [documentProject.DELETE, "DELETE", `/api/documents/${d.id}/project`, d.id, undefined],
      [deleteAll.DELETE, "DELETE", "/api/me/data", undefined, undefined],
    ] as const;
    for (const [index, [handler, method, path, id, json]] of cases.entries()) {
      const headers = { "x-forwarded-for": `198.51.100.${index + 10}` };
      const invoke = () => callRoute(handler, request(method, path, { headers, json }), id ? { id } : {});
      const first = await invoke();
      expect([200, 204]).toContain(first.status);
      expect((await invoke()).status).toBe(429);
    }
  });
});
