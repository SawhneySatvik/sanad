// Cross-principal access through the document routes: a document or storage ref that exists but
// belongs to someone else answers exactly like one that does not exist — the same 404 status and
// a byte-identical body. Every denial has a positive control showing the owner succeeds.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as documentsRoute from "@/app/api/documents/route";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as analyzeRoute from "@/app/api/documents/[id]/analyze/route";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { leaseOutput } from "@tests/support/services/understand";
import type { RouteHandler } from "@/server/http/handler";
import {
  analyzedDocumentViaRoutes,
  callRoute,
  createRouteHarness,
  guestCookie,
  request,
  TEST_MODEL_ID,
  unavailable,
  uploadViaRoutes,
  userA,
  userB,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

const MALFORMED_IDS = ["not-a-uuid", "0", "..%2F..%2Fetc", "' OR 1=1 --"];

interface IdRoute {
  name: string;
  handler: RouteHandler;
  method: string;
  path: (id: string) => string;
}

const ID_ROUTES: IdRoute[] = [
  { name: "GET /api/documents/:id", handler: documentRoute.GET, method: "GET", path: (id) => `/api/documents/${id}` },
  {
    name: "POST /api/documents/:id/analyze",
    handler: analyzeRoute.POST,
    method: "POST",
    path: (id) => `/api/documents/${id}/analyze`,
  },
];

function callIdRoute(route: IdRoute, id: string, cookie: string | null) {
  return callRoute(route.handler, request(route.method, route.path(encodeURIComponent(id)), { cookie }), { id });
}

async function statusAndBody(res: Response): Promise<[number, string]> {
  return [res.status, await res.text()];
}

describe.each(ID_ROUTES)("$name", (route) => {
  beforeEach(async () => {
    h = await createRouteHarness();
  });

  it("guest: a foreign id, a missing id and malformed ids are the same 404, byte for byte", async () => {
    const owner = guestCookie();
    const intruder = guestCookie();
    const id = await analyzedDocumentViaRoutes(owner.cookie);

    const foreign = await statusAndBody(await callIdRoute(route, id, intruder.cookie));
    const missing = await statusAndBody(await callIdRoute(route, randomUUID(), intruder.cookie));
    const malformed = await Promise.all(
      MALFORMED_IDS.map(async (bad) => statusAndBody(await callIdRoute(route, bad, intruder.cookie))),
    );

    expect(foreign[0]).toBe(404);
    expect(JSON.parse(foreign[1])).toEqual({
      error: { code: "NOT_FOUND", message: "The requested resource could not be found." },
    });
    expect(missing).toEqual(foreign);
    for (const each of malformed) expect(each).toEqual(foreign);

    // Positive control: the owner's identical request succeeds.
    expect((await callIdRoute(route, id, owner.cookie)).status).toBe(200);
  });

  it("user: another user's document is the same 404 a missing one is; the owner gets 200", async () => {
    h.signIn(userA);
    const id = await analyzedDocumentViaRoutes(null);

    h.signIn(userB);
    const foreign = await statusAndBody(await callIdRoute(route, id, null));
    const missing = await statusAndBody(await callIdRoute(route, randomUUID(), null));
    expect(foreign[0]).toBe(404);
    expect(missing).toEqual(foreign);

    // A guest holding no claim to it is denied the same way.
    h.signIn(null);
    expect(await statusAndBody(await callIdRoute(route, id, guestCookie().cookie))).toEqual(foreign);

    h.signIn(userA);
    expect((await callIdRoute(route, id, null)).status).toBe(200);
  });
});

describe("POST /api/documents/:id/analyze — an intruder cannot spend the owner's analysis", () => {
  it("a foreign not-analysed document is 404 and makes no model call", async () => {
    h = await createRouteHarness({
      primary: new FakeLlmClient({
        modelUsed: TEST_MODEL_ID,
        responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "primary down") }],
        defaultResponse: { data: leaseOutput() },
      }),
      secondary: unavailable(),
    });
    const owner = guestCookie();
    const input = await uploadViaRoutes(owner.cookie);
    const failed = await callRoute(
      documentsRoute.POST,
      request("POST", "/api/documents", { cookie: owner.cookie, json: input }),
    );
    const { documentId } = ((await failed.json()) as { error: { documentId: string } }).error;
    const callsBefore = h.primary.callCount;

    const intruder = await callIdRoute(ID_ROUTES[1], documentId, guestCookie().cookie);

    expect(intruder.status).toBe(404);
    expect(h.primary.callCount).toBe(callsBefore);
    // Positive control: the owner's retry does call the model and completes.
    expect((await callIdRoute(ID_ROUTES[1], documentId, owner.cookie)).status).toBe(200);
    expect(h.primary.callCount).toBe(callsBefore + 1);
  });
});

describe("POST /api/documents — a storage ref is confirmed only by the principal it was minted for", () => {
  beforeEach(async () => {
    h = await createRouteHarness();
  });

  function postDocument(cookie: string | null, json: unknown) {
    return callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json }));
  }

  it("a foreign ref, a never-uploaded ref and a malformed ref are the same 404; the owner's confirm still succeeds after", async () => {
    const owner = guestCookie();
    const intruder = guestCookie();
    const input = await uploadViaRoutes(owner.cookie);

    const foreign = await statusAndBody(await postDocument(intruder.cookie, input));
    const neverUploaded = await statusAndBody(
      await postDocument(intruder.cookie, {
        ...input,
        storageRef: `guest:${intruder.guestSessionId}/${randomUUID()}/lease.txt`,
      }),
    );
    const malformed = await statusAndBody(await postDocument(intruder.cookie, { ...input, storageRef: "../../etc/passwd" }));

    expect(foreign[0]).toBe(404);
    expect(neverUploaded).toEqual(foreign);
    expect(malformed).toEqual(foreign);
    const documents = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM documents");
    expect(documents.rows[0].n).toBe(0);
    expect(h.primary.callCount).toBe(0);

    // Positive control: the intruder's attempt did not consume the one-shot confirm.
    expect((await postDocument(owner.cookie, input)).status).toBe(200);
  });

  it("user B cannot confirm user A's upload", async () => {
    h.signIn(userA);
    const input = await uploadViaRoutes(null);

    h.signIn(userB);
    expect((await postDocument(null, input)).status).toBe(404);

    h.signIn(userA);
    expect((await postDocument(null, input)).status).toBe(200);
  });
});
