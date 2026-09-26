// GET /api/documents/:id/text: a foreign or missing document id is an identical 404, whether or not
// the request carries a stale If-None-Match, and whether or not it carries the real owner's own
// ETag or "*" — cache() only ever runs on run()'s result, so a foreign id throws inside getText()
// before cache() is reached at all, and the conditional path never gets a chance to short-circuit
// the access check.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import * as documentTextRoute from "@/app/api/documents/[id]/text/route";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

async function storedCanonicalTextHash(h: RouteHarness, documentId: string): Promise<string> {
  const [row] = await h.t.db.select({ canonicalTextHash: schema.documents.canonicalTextHash }).from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!row?.canonicalTextHash) throw new Error("document has no stored canonical_text_hash");
  return row.canonicalTextHash;
}

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

  it("the real owner's own ETag, and even If-None-Match: *, still 404 for a non-owner — a matching tag is never enough on its own", async () => {
    h = await createRouteHarness();
    h.signIn(userB);
    const foreignId = await analyzedDocumentViaRoutes(null);
    const hash = await storedCanonicalTextHash(h, foreignId);
    h.signIn(userA);

    // Positive control, same principal as the row: proves the header really does match this row's tag.
    h.signIn(userB);
    const ownerHit = await getText(foreignId, null, { "if-none-match": `"${hash}"` });
    expect(ownerHit.status).toBe(304);
    h.signIn(userA);

    const missingBody = await (await getText(randomUUID(), null)).text();
    for (const ifNoneMatch of [`"${hash}"`, "*"]) {
      const intruder = await getText(foreignId, null, { "if-none-match": ifNoneMatch });
      expect(intruder.status, ifNoneMatch).toBe(404);
      expect(intruder.headers.get("etag"), ifNoneMatch).toBeNull();
      expect(intruder.headers.get("cache-control"), ifNoneMatch).toBe("no-store");
      expect(await intruder.text(), ifNoneMatch).toBe(missingBody);
    }
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
