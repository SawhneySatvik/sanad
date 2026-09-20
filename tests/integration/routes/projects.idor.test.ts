// Cross-principal denials for GET /api/projects/:id. Byte-identical NOT_FOUND for another user's
// project, a missing id, a malformed id and any guest — the owner reads it. The repository's own
// exhaustive suite is tests/unit/server/data/projects.idor.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as projectRoute from "@/app/api/projects/[id]/route";
import * as projectsRoute from "@/app/api/projects/route";
import { callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";
const MALFORMED_ID = "not-a-uuid";

describe("GET /api/projects/:id IDOR", () => {
  it("another user's project, a missing id, a malformed id and a guest are the same byte-identical NOT_FOUND; the owner reads it", async () => {
    h.signIn(userA);
    const createRes = await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "a's" } }));
    const project = await createRes.json();

    const missingRes = await callRoute(projectRoute.GET, request("GET", `/api/projects/${MISSING_ID}`), { id: MISSING_ID });
    expect(missingRes.status).toBe(404);
    const missingBody = await missingRes.text();

    h.signIn(userB);
    const foreignRes = await callRoute(projectRoute.GET, request("GET", `/api/projects/${project.id}`), { id: project.id });
    expect(foreignRes.status).toBe(404);
    expect(await foreignRes.text()).toBe(missingBody);

    h.signIn(userA);
    const malformedRes = await callRoute(projectRoute.GET, request("GET", `/api/projects/${MALFORMED_ID}`), { id: MALFORMED_ID });
    expect(malformedRes.status).toBe(404);
    expect(await malformedRes.text()).toBe(missingBody);

    const { cookie } = guestCookie();
    h.signIn(null);
    const guestRes = await callRoute(projectRoute.GET, request("GET", `/api/projects/${project.id}`, { cookie }), { id: project.id });
    expect(guestRes.status).toBe(404);
    expect(await guestRes.text()).toBe(missingBody);

    // Positive control: the owner reads it.
    h.signIn(userA);
    const ownerRes = await callRoute(projectRoute.GET, request("GET", `/api/projects/${project.id}`), { id: project.id });
    expect(ownerRes.status).toBe(200);
    expect((await ownerRes.json()).project.id).toBe(project.id);
  });

  it("listProjects (GET /api/projects) never returns another user's project", async () => {
    h.signIn(userB);
    await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "b's" } }));
    h.signIn(userA);
    const createRes = await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "a's" } }));
    const mine = await createRes.json();

    const res = await callRoute(projectsRoute.GET, request("GET", "/api/projects"));
    const body = await res.json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual([mine.id]);
  });
});
