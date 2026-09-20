// POST /api/ask — a foreign, missing or malformed documentId is the same 404 every other route
// gives, byte for byte, error-first over SSE (never a 200 stream), with a positive control for the
// owner. ask.ts authorizes every named document before any model call.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as askRoute from "@/app/api/ask/route";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { leaseOutput } from "@tests/support/services/understand";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, guestCookie, request, TEST_MODEL_ID, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

const MALFORMED_IDS = ["not-a-uuid", "0", "' OR 1=1 --"];

function ask(cookie: string | null, documentId: string) {
  return callRoute(askRoute.POST, request("POST", "/api/ask", { cookie, json: { query: "What does it say?", documentIds: [documentId] } }));
}
async function statusAndBody(res: Response): Promise<[number, string]> {
  return [res.status, await res.text()];
}

describe("a foreign/missing/malformed documentId never streams — a 404 error-first response", () => {
  it("byte-identical across foreign, missing and malformed; the owner's own document streams normally", async () => {
    h = await createRouteHarness({
      // Queue: the document's own analysis (understand.analyze) consumes the first entry
      // ({findings} shape); the positive control's single-specialist ask() call consumes the
      // second ({answer, citations} shape).
      primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, responses: [{ data: leaseOutput() }, { data: { answer: "It says X.", citations: [] } }] }),
    });
    const owner = guestCookie();
    const intruder = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(owner.cookie);

    const foreign = await statusAndBody(await ask(intruder.cookie, documentId));
    const missing = await statusAndBody(await ask(intruder.cookie, randomUUID()));
    const malformed = await Promise.all(MALFORMED_IDS.map(async (bad) => statusAndBody(await ask(intruder.cookie, bad))));

    expect(foreign[0]).toBe(404);
    expect(foreign[0]).not.toBe(200);
    expect(JSON.parse(foreign[1])).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });
    expect(missing).toEqual(foreign);
    for (const each of malformed) expect(each).toEqual(foreign);

    // None of the foreign/missing/malformed attempts ever reached the model — the document
    // authorization check runs before any LLM call. Only the 1 call already spent on the
    // document's own analysis (above) has happened so far.
    expect(h.primary.callCount).toBe(1);

    // Positive control: the owner's own document streams (never blocked by the same check), and
    // THIS is the call that actually reaches the model.
    const owned = await ask(owner.cookie, documentId);
    expect(owned.status).toBe(200);
    expect(owned.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(h.primary.callCount).toBe(2);
  });
});
