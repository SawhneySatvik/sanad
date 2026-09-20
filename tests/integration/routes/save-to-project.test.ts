// POST /api/{documents,comparisons,drafts,threads}/:id/save-to-project — any standalone item can be
// saved into a project after the fact. Positive HTTP-layer flows for all four kinds; cross-principal
// denials are save-to-project.idor.test.ts.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import * as comparisonSaveRoute from "@/app/api/comparisons/[id]/save-to-project/route";
import * as documentSaveRoute from "@/app/api/documents/[id]/save-to-project/route";
import * as draftSaveRoute from "@/app/api/drafts/[id]/save-to-project/route";
import * as threadSaveRoute from "@/app/api/threads/[id]/save-to-project/route";
import * as projectsRoute from "@/app/api/projects/route";
import { insertComparison, insertDocument, insertDraftChain } from "@tests/support/auth/claim";
import { insertThread } from "@tests/support/data/projects";
import { callRoute, createRouteHarness, request, userA, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

async function createProject(harness: RouteHarness): Promise<string> {
  harness.signIn(userA);
  const res = await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "p" } }));
  return ((await res.json()) as { id: string }).id;
}

describe("save-to-project", () => {
  it("document: saves it, clears expires_at in the same statement", async () => {
    const projectId = await createProject(h);
    const document = await insertDocument(h.t, userA, new Date(Date.now() + 3_600_000));
    h.signIn(userA);
    const res = await callRoute(
      documentSaveRoute.POST,
      request("POST", `/api/documents/${document.id}/save-to-project`, { json: { projectId } }),
      { id: document.id },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId, itemIds: [document.id] });
    const [row] = await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, document.id));
    expect(row.projectId).toBe(projectId);
    expect(row.expiresAt).toBeNull();
  });

  it("comparison: saves it", async () => {
    const projectId = await createProject(h);
    const a = await insertDocument(h.t, userA, null);
    const b = await insertDocument(h.t, userA, null);
    const comparison = await insertComparison(h.t, userA, a.id, b.id, null);
    h.signIn(userA);
    const res = await callRoute(
      comparisonSaveRoute.POST,
      request("POST", `/api/comparisons/${comparison.id}/save-to-project`, { json: { projectId } }),
      { id: comparison.id },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId, itemIds: [comparison.id] });
  });

  it("draft: saving a mid-chain revision moves and returns the WHOLE chain", async () => {
    const projectId = await createProject(h);
    const chain = await insertDraftChain(h.t, userA, null, null, 3);
    h.signIn(userA);
    const res = await callRoute(
      draftSaveRoute.POST,
      request("POST", `/api/drafts/${chain[1].id}/save-to-project`, { json: { projectId } }),
      { id: chain[1].id },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectId).toBe(projectId);
    expect([...body.itemIds].sort()).toEqual(chain.map((d) => d.id).sort());
    for (const revision of chain) {
      const [row] = await h.t.db.select().from(schema.drafts).where(eq(schema.drafts.id, revision.id));
      expect(row.projectId).toBe(projectId);
      expect(row.expiresAt).toBeNull();
    }
  });

  it("thread: saves it (threads have no guest owner column)", async () => {
    const projectId = await createProject(h);
    const thread = await insertThread(h.t, userA.userId);
    h.signIn(userA);
    const res = await callRoute(
      threadSaveRoute.POST,
      request("POST", `/api/threads/${thread.id}/save-to-project`, { json: { projectId } }),
      { id: thread.id },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId, itemIds: [thread.id] });
  });

  it("a save-to-project POST without Content-Type: application/json is rejected", async () => {
    const projectId = await createProject(h);
    const document = await insertDocument(h.t, userA, null);
    h.signIn(userA);
    const req = new Request(`http://localhost/api/documents/${document.id}/save-to-project`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
    const res = await callRoute(documentSaveRoute.POST, req, { id: document.id });
    expect(res.status).toBe(400);
  });
});
