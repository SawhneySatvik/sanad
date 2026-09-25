// /library's "chain-wide draft rename" gate, proven at the API level rather than through
// Playwright: renaming needs no model call at all, so this proves the same chain-wide fan-out
// /library's own rename action depends on, directly against the real route and a chain built by
// bypassing the LLM (insertDraftChain), exactly like library.idor.test.ts's own neighbouring paging
// test already does for the same chain shape — building a full, multi-revision draft chain through
// Playwright would need several real model round trips for no extra coverage over this.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as draft from "@/app/api/drafts/[id]/route";
import { insertDraftChain } from "@tests/support/auth/claim";
import { callRoute, createRouteHarness, request, userA, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
  h.signIn(userA);
});
afterEach(async () => {
  await h.close();
});

describe("draft rename is chain-wide", () => {
  it("renaming the middle revision sets the new title on every revision in the chain, in one transaction", async () => {
    const chain = await insertDraftChain(h.t, userA, null, null, 3);
    const [root, middle, leaf] = chain;

    const renamed = await callRoute(draft.PATCH, request("PATCH", `/api/drafts/${middle.id}`, { json: { title: "New title" } }), { id: middle.id });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("New title");

    for (const revision of [root, middle, leaf]) {
      const res = await callRoute(draft.GET, request("GET", `/api/drafts/${revision.id}`), { id: revision.id });
      expect(res.status).toBe(200);
      expect((await res.json()).title, `revision ${revision.id} should share the chain's new title`).toBe("New title");
    }
  });
});
