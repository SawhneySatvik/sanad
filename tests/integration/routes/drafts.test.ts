// POST /api/drafts, POST /api/drafts/:id/revise, GET /api/drafts/:id — over real PGlite +
// FakeLlmClients, through the actual route handlers (CLAUDE.md mocking policy).

import { afterEach, describe, expect, it } from "vitest";
import * as draftRoute from "@/app/api/drafts/[id]/route";
import * as reviseRoute from "@/app/api/drafts/[id]/revise/route";
import * as draftsRoute from "@/app/api/drafts/route";
import { draftModelOutput } from "@tests/support/services/draft";
import type { DraftWithSectionsOutput } from "@/shared/contracts/drafts";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

const CREATE_INPUT = {
  mode: "from_scratch",
  documentType: "nda",
  userInstructions: "Draft an NDA between Acme Pvt Ltd and Bob Freelancer.",
  jurisdiction: "IN",
};

async function createDraft(cookie: string | null): Promise<DraftWithSectionsOutput> {
  h.primary.enqueue({ data: draftModelOutput("nda") });
  const res = await callRoute(draftsRoute.POST, request("POST", "/api/drafts", { cookie, json: CREATE_INPUT }));
  expect(res.status).toBe(200);
  return (await res.json()) as DraftWithSectionsOutput;
}

describe("POST /api/drafts", () => {
  it("creates a from_scratch draft with templated + ai_generated sections, no status field anywhere", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;

    const body = await createDraft(cookie);

    expect(body.mode).toBe("from_scratch");
    expect(body.documentType).toBe("nda");
    expect(body.groundingDocumentId).toBeNull();
    expect(body.groundingDocumentAvailable).toBeNull();
    expect(body.modelUsed).toBe("fake-model");
    expect(body.revisionNumber).toBe(1);
    expect(body.parentDraftId).toBeNull();
    expect(body.sections.map((s) => s.provenance).sort()).toEqual([
      "ai_generated",
      "ai_generated",
      "ai_generated",
      "ai_generated",
      "ai_generated",
      "templated",
      "templated",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/"status"/);
  });

  it("rejects a request naming an unsupported documentType", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;

    const res = await callRoute(draftsRoute.POST, request("POST", "/api/drafts", { cookie, json: { ...CREATE_INPUT, documentType: "power_of_attorney" } }));

    expect(res.status).toBe(400);
  });
});

describe("POST /api/drafts/:id/revise", () => {
  it("creates a new revision, inheriting jurisdiction and expiresAt from the parent", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const parent = await createDraft(cookie);

    h.primary.enqueue({ data: draftModelOutput("nda", { parties_and_purpose: "Acme Pvt Ltd and Bob Freelancer, revised." }) });
    const res = await callRoute(
      reviseRoute.POST,
      request("POST", `/api/drafts/${parent.id}/revise`, { cookie, json: { userInstructions: "Make the term 2 years." } }),
      { id: parent.id },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftWithSectionsOutput;
    expect(body.revisionNumber).toBe(2);
    expect(body.parentDraftId).toBe(parent.id);
    expect(body.jurisdiction).toBe(parent.jurisdiction);
    expect(body.sections.find((s) => s.key === "parties_and_purpose")?.content).toBe("Acme Pvt Ltd and Bob Freelancer, revised.");
  });

  // Expired is treated as gone even for the OWNER (data/drafts.ts's own rule). Tampers expires_at
  // directly, since guest drafts do carry a real TTL (DRAFT_GUEST_TTL_SECONDS).
  it("an expired draft is 404 to revise, identical to a missing one — even for its own owner", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const parent = await createDraft(cookie);
    const callsBefore = h.primary.callCount;

    await h.t.client.query("UPDATE drafts SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 60_000), parent.id]);

    const expired = await callRoute(
      reviseRoute.POST,
      request("POST", `/api/drafts/${parent.id}/revise`, { cookie, json: { userInstructions: "x" } }),
      { id: parent.id },
    );
    const missing = await callRoute(
      reviseRoute.POST,
      request("POST", "/api/drafts/0f0f0f0f-0000-4000-8000-000000000000/revise", { cookie, json: { userInstructions: "x" } }),
      { id: "0f0f0f0f-0000-4000-8000-000000000000" },
    );

    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe(await missing.text());
    expect(h.primary.callCount).toBe(callsBefore); // no LLM call spent revising an already-gone draft
  });
});

describe("GET /api/drafts/:id", () => {
  it("reads back a created draft, with promptVersion null (not persisted)", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const created = await createDraft(cookie);

    const res = await callRoute(draftRoute.GET, request("GET", `/api/drafts/${created.id}`, { cookie }), { id: created.id });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DraftWithSectionsOutput;
    expect(body).toEqual({ ...created, promptVersion: null });
  });

  // Same as the revise case above — expired is 404 even to its own owner.
  it("an expired draft is 404 to read, identical to a missing one — even for its own owner", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const parent = await createDraft(cookie);

    await h.t.client.query("UPDATE drafts SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 60_000), parent.id]);

    const expired = await callRoute(draftRoute.GET, request("GET", `/api/drafts/${parent.id}`, { cookie }), { id: parent.id });
    const missing = await callRoute(
      draftRoute.GET,
      request("GET", "/api/drafts/0f0f0f0f-0000-4000-8000-000000000000", { cookie }),
      { id: "0f0f0f0f-0000-4000-8000-000000000000" },
    );

    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe(await missing.text());
  });
});
