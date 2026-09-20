// Cross-principal access through the draft routes: a document_grounded draft naming another
// principal's document is NOT_FOUND and never spends an LLM call; a foreign/missing/malformed draft
// id is the same 404 for revise and get.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as draftRoute from "@/app/api/drafts/[id]/route";
import * as reviseRoute from "@/app/api/drafts/[id]/revise/route";
import * as draftsRoute from "@/app/api/drafts/route";
import { draftModelOutput } from "@tests/support/services/draft";
import type { DraftWithSectionsOutput } from "@/shared/contracts/drafts";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

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

function postDraft(cookie: string | null, groundingDocumentId: string) {
  return callRoute(
    draftsRoute.POST,
    request("POST", "/api/drafts", {
      cookie,
      json: {
        mode: "document_grounded",
        documentType: "leave_and_license",
        groundingDocumentId,
        userInstructions: "Draft a fresh leave and license agreement grounded in the document.",
        jurisdiction: "IN",
      },
    }),
  );
}

async function statusAndBody(res: Response): Promise<[number, string]> {
  return [res.status, await res.text()];
}

describe("POST /api/drafts — document_grounded mode never grounds in another principal's document", () => {
  it("guest: a foreign, missing and malformed groundingDocumentId are the same 404; the owner's own document succeeds", async () => {
    h = await createRouteHarness();
    const owner = guestCookie();
    const intruder = guestCookie();
    const ownerDocumentId = await analyzedDocumentViaRoutes(owner.cookie);
    const callsBefore = h.primary.callCount;

    const foreign = await statusAndBody(await postDraft(intruder.cookie, ownerDocumentId));
    const missing = await statusAndBody(await postDraft(intruder.cookie, randomUUID()));
    const malformed = await statusAndBody(await postDraft(intruder.cookie, "not-a-uuid"));

    expect(foreign[0]).toBe(404);
    expect(JSON.parse(foreign[1])).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });
    expect(missing).toEqual(foreign);
    expect(malformed).toEqual(foreign);
    // No LLM call spent on any of the three denials (services/draft.ts checks ownership BEFORE the
    // model call).
    expect(h.primary.callCount).toBe(callsBefore);

    h.primary.enqueue({ data: draftModelOutput("leave_and_license") });
    expect((await postDraft(owner.cookie, ownerDocumentId)).status).toBe(200);
    expect(h.primary.callCount).toBe(callsBefore + 1);
  });

  it("user: another user's document is NOT_FOUND and spends no LLM call; the owner's own document succeeds", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const aDocumentId = await analyzedDocumentViaRoutes(null);
    h.signIn(userB);
    const callsBefore = h.primary.callCount;

    expect((await postDraft(null, aDocumentId)).status).toBe(404);
    expect(h.primary.callCount).toBe(callsBefore);

    const bDocumentId = await analyzedDocumentViaRoutes(null);
    h.primary.enqueue({ data: draftModelOutput("leave_and_license") });
    expect((await postDraft(null, bDocumentId)).status).toBe(200);
  });
});

describe("POST /api/drafts/:id/revise and GET /api/drafts/:id — cross-principal on the draft id itself", () => {
  it("user: another user's draft is the same 404 a missing/malformed one is; the owner still reads and revises it", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    h.primary.enqueue({ data: draftModelOutput("nda") });
    const created = (await (
      await callRoute(
        draftsRoute.POST,
        request("POST", "/api/drafts", {
          cookie: null,
          json: { mode: "from_scratch", documentType: "nda", userInstructions: "Draft an NDA.", jurisdiction: "IN" },
        }),
      )
    ).json()) as DraftWithSectionsOutput;

    h.signIn(userB);
    const callsBefore = h.primary.callCount;
    async function attemptGet(id: string) {
      return statusAndBody(await callRoute(draftRoute.GET, request("GET", `/api/drafts/${id}`, { cookie: null }), { id }));
    }
    async function attemptRevise(id: string) {
      return statusAndBody(
        await callRoute(reviseRoute.POST, request("POST", `/api/drafts/${id}/revise`, { cookie: null, json: { userInstructions: "x" } }), { id }),
      );
    }

    const foreignGet = await attemptGet(created.id);
    const missingGet = await attemptGet(randomUUID());
    const malformedGet = await attemptGet("not-a-uuid");
    expect(foreignGet[0]).toBe(404);
    expect(missingGet).toEqual(foreignGet);
    expect(malformedGet).toEqual(foreignGet);

    const foreignRevise = await attemptRevise(created.id);
    expect(foreignRevise[0]).toBe(404);
    expect(foreignRevise).toEqual(foreignGet);
    // No LLM call spent on the denied revise attempt (draft.ts's revise() authorizes via
    // getDraftRow/canAccess BEFORE ever calling the model).
    expect(h.primary.callCount).toBe(callsBefore);

    h.signIn(userA);
    expect((await attemptGet(created.id))[0]).toBe(200);
    h.primary.enqueue({ data: draftModelOutput("nda") });
    expect((await attemptRevise(created.id))[0]).toBe(200);
    expect(h.primary.callCount).toBe(callsBefore + 1);
  });

  // Cross-principal tests belong in *.idor.test.ts — the release-blocker `npm test -- idor` filter
  // matches file paths.
  it("guest: a foreign, missing and malformed draft id are the same 404, byte for byte, for both revise and get; the owner still uses it, spending no LLM call on any denial", async () => {
    h = await createRouteHarness();
    const owner = guestCookie();
    const intruder = guestCookie();
    h.primary.enqueue({ data: draftModelOutput("nda") });
    const created = (await (
      await callRoute(draftsRoute.POST, request("POST", "/api/drafts", { cookie: owner.cookie, json: CREATE_INPUT }))
    ).json()) as DraftWithSectionsOutput;
    const callsBefore = h.primary.callCount;

    async function attemptGet(id: string) {
      return statusAndBody(await callRoute(draftRoute.GET, request("GET", `/api/drafts/${id}`, { cookie: intruder.cookie }), { id }));
    }
    async function attemptRevise(id: string) {
      return statusAndBody(
        await callRoute(
          reviseRoute.POST,
          request("POST", `/api/drafts/${id}/revise`, { cookie: intruder.cookie, json: { userInstructions: "x" } }),
          { id },
        ),
      );
    }

    const foreignGet = await attemptGet(created.id);
    const missingGet = await attemptGet(randomUUID());
    const malformedGet = await attemptGet("not-a-uuid");
    expect(foreignGet[0]).toBe(404);
    expect(JSON.parse(foreignGet[1])).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });
    expect(missingGet).toEqual(foreignGet);
    expect(malformedGet).toEqual(foreignGet);

    const foreignRevise = await attemptRevise(created.id);
    const missingRevise = await attemptRevise(randomUUID());
    const malformedRevise = await attemptRevise("not-a-uuid");
    expect(foreignRevise[0]).toBe(404);
    expect(foreignRevise).toEqual(foreignGet);
    expect(missingRevise).toEqual(foreignGet);
    expect(malformedRevise).toEqual(foreignGet);
    expect(h.primary.callCount).toBe(callsBefore); // no LLM call spent on any of the six denials

    expect(
      (await callRoute(draftRoute.GET, request("GET", `/api/drafts/${created.id}`, { cookie: owner.cookie }), { id: created.id })).status,
    ).toBe(200);
    h.primary.enqueue({ data: draftModelOutput("nda") });
    expect(
      (
        await callRoute(
          reviseRoute.POST,
          request("POST", `/api/drafts/${created.id}/revise`, { cookie: owner.cookie, json: { userInstructions: "x" } }),
          { id: created.id },
        )
      ).status,
    ).toBe(200);
    expect(h.primary.callCount).toBe(callsBefore + 1);
  });
});
