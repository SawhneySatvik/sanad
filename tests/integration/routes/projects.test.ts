// POST/GET /api/projects, GET /api/projects/:id (docs/API.md). Positive HTTP-layer flows;
// cross-principal denials are projects.idor.test.ts. The repository's own exhaustive suite is
// tests/unit/server/data/projects.idor.test.ts — these prove the route -> repo -> contract wiring.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as projectRoute from "@/app/api/projects/[id]/route";
import * as projectsRoute from "@/app/api/projects/route";
import { insertComparison, insertDocument, insertDraftChain } from "@tests/support/auth/claim";
import * as projects from "@/server/data/projects";
import { insertThread } from "@tests/support/data/projects";
import { callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

describe("POST /api/projects", () => {
  it("creates a project for the signed-in user; no owner column on the wire", async () => {
    h.signIn(userA);
    const res = await callRoute(
      projectsRoute.POST,
      request("POST", "/api/projects", { json: { name: "Flat lease", color: "teal", icon: "home" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "Flat lease", color: "teal", icon: "home" });
    expect(typeof body.id).toBe("string");
    expect(body).not.toHaveProperty("ownerUserId");
  });

  it("a guest is rejected with a typed 400 — no project is ever a guest's", async () => {
    const { cookie } = guestCookie();
    const res = await callRoute(projectsRoute.POST, request("POST", "/api/projects", { cookie, json: { name: "x" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("an unknown body field (e.g. a client-sent ownerUserId) is a 400 — the request contract is strict", async () => {
    h.signIn(userA);
    const res = await callRoute(
      projectsRoute.POST,
      request("POST", "/api/projects", { json: { name: "x", ownerUserId: userB.userId } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects", () => {
  it("lists only the signed-in user's projects, most recently opened first; a guest gets an empty list, not an error", async () => {
    h.signIn(userA);
    await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "mine" } }));
    h.signIn(userB);
    await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "b's" } }));

    h.signIn(userA);
    const res = await callRoute(projectsRoute.GET, request("GET", "/api/projects"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].name).toBe("mine");

    const { cookie } = guestCookie();
    h.signIn(null);
    const guestRes = await callRoute(projectsRoute.GET, request("GET", "/api/projects", { cookie }));
    expect(guestRes.status).toBe(200);
    expect((await guestRes.json()).projects).toEqual([]);
  });
});

describe("GET /api/projects/:id", () => {
  it("returns the project detail with its saved items; no owner columns, canonical text, storage ref, draft content or processing status anywhere in the payload", async () => {
    h.signIn(userA);
    const createRes = await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "p" } }));
    const project = await createRes.json();

    const document = await insertDocument(h.t, userA, null);
    const other = await insertDocument(h.t, userA, null);
    const comparison = await insertComparison(h.t, userA, document.id, other.id, null);
    const chain = await insertDraftChain(h.t, userA, null, null, 1);
    const thread = await insertThread(h.t, userA.userId);
    await projects.saveToProject(h.t.db, userA, { kind: "document", id: document.id }, project.id);
    await projects.saveToProject(h.t.db, userA, { kind: "comparison", id: comparison.id }, project.id);
    await projects.saveToProject(h.t.db, userA, { kind: "draft", id: chain[0].id }, project.id);
    await projects.saveToProject(h.t.db, userA, { kind: "thread", id: thread.id }, project.id);

    const res = await callRoute(projectRoute.GET, request("GET", `/api/projects/${project.id}`), { id: project.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.id).toBe(project.id);
    expect(body.documents.map((d: { id: string }) => d.id)).toEqual([document.id]);
    // `other` was never saved — standalone items stay out.
    expect(body.comparisons.map((c: { id: string }) => c.id)).toEqual([comparison.id]);
    expect(body.drafts.map((d: { id: string }) => d.id)).toEqual([chain[0].id]);
    expect(body.threads.map((t: { id: string }) => t.id)).toEqual([thread.id]);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain(document.canonicalText!);
    expect(raw).not.toContain(chain[0].content);
    expect(raw).not.toMatch(/storageRef|storage_ref|ownerUserId|owner_user_id|ownerGuestSessionId|processingStatus/);
  });
});
