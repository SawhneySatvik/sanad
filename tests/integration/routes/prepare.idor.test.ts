// Cross-principal access through POST /api/documents/:id/prepare: a foreign, missing or malformed
// document id is the same 404, and no model call is ever spent reading another principal's document.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as prepareRoute from "@/app/api/documents/[id]/prepare/route";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

function callPrepare(documentId: string, cookie: string | null) {
  return callRoute(prepareRoute.POST, request("POST", `/api/documents/${documentId}/prepare`, { cookie }), { id: documentId });
}

async function statusAndBody(res: Response): Promise<[number, string]> {
  return [res.status, await res.text()];
}

describe("POST /api/documents/:id/prepare — cross-principal", () => {
  it("guest: a foreign, missing and malformed document id are the same 404, byte for byte; the owner still prepares it, spending no extra model call for the denials", async () => {
    h = await createRouteHarness();
    const owner = guestCookie();
    const intruder = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(owner.cookie);
    const callsBefore = h.primary.callCount;

    const foreign = await statusAndBody(await callPrepare(documentId, intruder.cookie));
    const missing = await statusAndBody(await callPrepare(randomUUID(), intruder.cookie));
    const malformed = await statusAndBody(await callPrepare("not-a-uuid", intruder.cookie));

    expect(foreign[0]).toBe(404);
    expect(JSON.parse(foreign[1])).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });
    expect(missing).toEqual(foreign);
    expect(malformed).toEqual(foreign);
    expect(h.primary.callCount).toBe(callsBefore);

    h.primary.enqueue({ data: { lawyerQuestions: [], checklist: [{ item: "Confirm the fee.", findingIds: ["F1"] }] } });
    expect((await callPrepare(documentId, owner.cookie)).status).toBe(200);
  });

  it("user: another user's document is the same 404 a missing one is; the owner's own document succeeds", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const documentId = await analyzedDocumentViaRoutes(null);

    h.signIn(userB);
    const foreign = await statusAndBody(await callPrepare(documentId, null));
    const missing = await statusAndBody(await callPrepare(randomUUID(), null));
    expect(foreign[0]).toBe(404);
    expect(missing).toEqual(foreign);

    h.signIn(userA);
    h.primary.enqueue({ data: { lawyerQuestions: [{ question: "Is the fee negotiable?", whyItMatters: "It is a recurring cost.", findingIds: ["F1"] }], checklist: [] } });
    expect((await callPrepare(documentId, null)).status).toBe(200);
  });
});
