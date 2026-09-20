// Cross-principal denials for POST /api/{documents,comparisons,drafts,threads}/:id/save-to-project:
// every referenced entity — the item AND the target project — must be owned by the caller. Every
// denial below is the SAME byte-identical NOT_FOUND a missing id gets, never a 403.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as comparisonSaveRoute from "@/app/api/comparisons/[id]/save-to-project/route";
import * as documentSaveRoute from "@/app/api/documents/[id]/save-to-project/route";
import * as draftSaveRoute from "@/app/api/drafts/[id]/save-to-project/route";
import * as threadSaveRoute from "@/app/api/threads/[id]/save-to-project/route";
import * as projectsRoute from "@/app/api/projects/route";
import { insertComparison, insertDocument, insertDraftChain } from "@tests/support/auth/claim";
import type { RouteHandler } from "@/server/http/handler";
import { insertThread } from "@tests/support/data/projects";
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

async function createProjectFor(harness: RouteHarness, owner: typeof userA): Promise<string> {
  harness.signIn(owner);
  const res = await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "p" } }));
  return ((await res.json()) as { id: string }).id;
}

interface Kind {
  name: string;
  path: string;
  route: RouteHandler;
  itemOf(harness: RouteHarness, owner: typeof userA): Promise<string>;
  // Guest-owned rows need a real expires_at (the *_guest_expires_check constraints); undefined for
  // "thread" — threads have no guest owner at all, so there is no such fixture to build.
  guestItemOf?: (harness: RouteHarness, guestSessionId: string) => Promise<string>;
}

const inAnHour = () => new Date(Date.now() + 3_600_000);

const KINDS: Kind[] = [
  {
    name: "document",
    path: "documents",
    route: documentSaveRoute.POST,
    itemOf: async (harness, owner) => (await insertDocument(harness.t, owner, null)).id,
    guestItemOf: async (harness, guestSessionId) =>
      (await insertDocument(harness.t, { type: "guest", guestSessionId }, inAnHour())).id,
  },
  {
    name: "comparison",
    path: "comparisons",
    route: comparisonSaveRoute.POST,
    itemOf: async (harness, owner) => {
      const a = await insertDocument(harness.t, owner, null);
      const b = await insertDocument(harness.t, owner, null);
      return (await insertComparison(harness.t, owner, a.id, b.id, null)).id;
    },
    guestItemOf: async (harness, guestSessionId) => {
      const guest = { type: "guest" as const, guestSessionId };
      const a = await insertDocument(harness.t, guest, inAnHour());
      const b = await insertDocument(harness.t, guest, inAnHour());
      return (await insertComparison(harness.t, guest, a.id, b.id, inAnHour())).id;
    },
  },
  {
    name: "draft",
    path: "drafts",
    route: draftSaveRoute.POST,
    itemOf: async (harness, owner) => (await insertDraftChain(harness.t, owner, null, null, 1))[0].id,
    guestItemOf: async (harness, guestSessionId) =>
      (await insertDraftChain(harness.t, { type: "guest", guestSessionId }, inAnHour(), null, 1))[0].id,
  },
  {
    name: "thread",
    path: "threads",
    route: threadSaveRoute.POST,
    itemOf: async (harness, owner) => (await insertThread(harness.t, owner.userId)).id,
    // No guestItemOf: a thread can never be guest-owned — nothing to construct.
  },
];

// The repository's own exhaustive coverage is tests/unit/server/data/projects.idor.test.ts; this
// file proves the HTTP layer maps the same denials to the same wire bytes for all four routes.
describe("save-to-project IDOR", () => {
  for (const kind of KINDS) {
    it(`${kind.name}: a foreign item, my item into a foreign project, a malformed project id, a missing/malformed item id and a guest are one byte-identical NOT_FOUND; my item into my project succeeds`, async () => {
      const mineProject = await createProjectFor(h, userA);
      const foreignProject = await createProjectFor(h, userB);
      const mineItem = await kind.itemOf(h, userA);
      const foreignItem = await kind.itemOf(h, userB);
      const path = (id: string) => `/api/${kind.path}/${id}/save-to-project`;

      h.signIn(userA);
      const missingRes = await callRoute(
        kind.route,
        request("POST", path(MISSING_ID), { json: { projectId: mineProject } }),
        { id: MISSING_ID },
      );
      expect(missingRes.status).toBe(404);
      const missingBody = await missingRes.text();

      const foreignItemRes = await callRoute(
        kind.route,
        request("POST", path(foreignItem), { json: { projectId: mineProject } }),
        { id: foreignItem },
      );
      expect(foreignItemRes.status, "foreign item into my project").toBe(404);
      expect(await foreignItemRes.text(), "foreign item into my project").toBe(missingBody);

      const foreignProjectRes = await callRoute(
        kind.route,
        request("POST", path(mineItem), { json: { projectId: foreignProject } }),
        { id: mineItem },
      );
      expect(foreignProjectRes.status, "my item into a foreign project").toBe(404);
      expect(await foreignProjectRes.text(), "my item into a foreign project").toBe(missingBody);

      const bothForeignRes = await callRoute(
        kind.route,
        request("POST", path(foreignItem), { json: { projectId: foreignProject } }),
        { id: foreignItem },
      );
      expect(bothForeignRes.status, "foreign item into a foreign project").toBe(404);
      expect(await bothForeignRes.text(), "foreign item into a foreign project").toBe(missingBody);

      const malformedItemRes = await callRoute(
        kind.route,
        request("POST", path(MALFORMED_ID), { json: { projectId: mineProject } }),
        { id: MALFORMED_ID },
      );
      expect(malformedItemRes.status, "malformed item id").toBe(404);
      expect(await malformedItemRes.text(), "malformed item id").toBe(missingBody);

      // A malformed body projectId is also NOT_FOUND, byte-identical — never a 400, even though
      // SaveToProjectInput itself only requires a bounded string, not a guid.
      const malformedProjectRes = await callRoute(
        kind.route,
        request("POST", path(mineItem), { json: { projectId: MALFORMED_ID } }),
        { id: mineItem },
      );
      expect(malformedProjectRes.status, "malformed project id").toBe(404);
      expect(await malformedProjectRes.text(), "malformed project id").toBe(missingBody);

      // A guest can never save anything — no project is ever a guest's (the caller's principal is a
      // guest; the item and project below are userA's own, so this isn't a dup of the foreign-item
      // cases above, which are about the ITEM's owner, not the CALLER's).
      const { cookie } = guestCookie();
      h.signIn(null);
      const guestRes = await callRoute(
        kind.route,
        request("POST", path(mineItem), { cookie, json: { projectId: mineProject } }),
        { id: mineItem },
      );
      expect(guestRes.status, "guest caller").toBe(404);
      expect(await guestRes.text(), "guest caller").toBe(missingBody);

      // A real signed-in user cannot save a GUEST-owned item into their own project either — a
      // guest session is not a principal a user save can ever reach. N/A for threads: never guest-owned.
      if (kind.guestItemOf) {
        const { guestSessionId } = guestCookie();
        const guestItem = await kind.guestItemOf(h, guestSessionId);
        h.signIn(userA);
        const guestItemRes = await callRoute(
          kind.route,
          request("POST", path(guestItem), { json: { projectId: mineProject } }),
          { id: guestItem },
        );
        expect(guestItemRes.status, "guest-owned item").toBe(404);
        expect(await guestItemRes.text(), "guest-owned item").toBe(missingBody);
      }

      // Positive control: my item into my project succeeds.
      h.signIn(userA);
      const ok = await callRoute(kind.route, request("POST", path(mineItem), { json: { projectId: mineProject } }), {
        id: mineItem,
      });
      expect(ok.status, "positive control").toBe(200);
    });
  }
});
