// GET /api/documents/:id/text: a foreign or missing document id is an identical 404, whether or not
// the request carries a stale If-None-Match — there is no conditional-GET short-circuit for canAccess
// to be bypassed by.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as documentTextRoute from "@/app/api/documents/[id]/text/route";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

function getText(id: string, cookie: string | null, headers?: Record<string, string>) {
  return callRoute(documentTextRoute.GET, request("GET", `/api/documents/${id}/text`, { cookie, headers }), { id });
}

describe("GET /api/documents/:id/text — owner boundary", () => {
  it("a foreign document id is 404, byte-identical with and without a stale If-None-Match", async () => {
    h = await createRouteHarness();
    h.signIn(userB);
    const foreignId = await analyzedDocumentViaRoutes(null);
    h.signIn(userA);

    const plain = await getText(foreignId, null);
    const conditional = await getText(foreignId, null, { "if-none-match": '"stale-etag"' });

    expect(plain.status).toBe(404);
    expect(conditional.status).toBe(404);
    expect(await plain.text()).toBe(await conditional.text());
    expect(conditional.headers.get("etag")).toBeNull();
    expect(plain.headers.get("cache-control")).toBe("no-store");
    expect(conditional.headers.get("cache-control")).toBe("no-store");
  });

  it("a foreign guest's document is 404 to another guest, and a missing id is the identical 404", async () => {
    h = await createRouteHarness();
    const owner = guestCookie();
    const foreignId = await analyzedDocumentViaRoutes(owner.cookie);
    const intruder = guestCookie();

    const foreign = await getText(foreignId, intruder.cookie);
    const missing = await getText(randomUUID(), intruder.cookie);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(foreign.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("the positive control: the real owner reads the same document just fine", async () => {
    h = await createRouteHarness();
    const owner = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(owner.cookie);

    const res = await getText(documentId, owner.cookie);

    expect(res.status).toBe(200);
  });
});
