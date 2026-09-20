// GET/POST /api/threads/:id/messages: a foreign, missing or malformed thread id is the same 404
// every other route gives, byte for byte, with a positive control for the owner.
// Threads are user-owned only, so "foreign" here always means another user or a guest.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as messagesRoute from "@/app/api/threads/[id]/messages/route";
import * as threadsRoute from "@/app/api/threads/route";
import { LEASE } from "@tests/support/services/understand";
import { ThreadOutput } from "@/shared/contracts/threads";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

const MALFORMED_IDS = ["not-a-uuid", "0", "..%2F..%2Fetc", "' OR 1=1 --"];

function getMessages(id: string, cookie: string | null) {
  return callRoute(messagesRoute.GET, request("GET", `/api/threads/${encodeURIComponent(id)}/messages`, { cookie }), { id });
}
function askThread(id: string, cookie: string | null) {
  return callRoute(
    messagesRoute.POST,
    request("POST", `/api/threads/${encodeURIComponent(id)}/messages`, { cookie, json: { query: "hi" } }),
    { id },
  );
}
async function statusAndBody(res: Response): Promise<[number, string]> {
  return [res.status, await res.text()];
}

describe("GET /api/threads/:id/messages — foreign/missing/malformed are the same 404", () => {
  it("another user's thread, a missing thread and malformed ids are byte-identical; the owner gets 200", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const created = ThreadOutput.parse(await (await callRoute(threadsRoute.POST, request("POST", "/api/threads", { json: { title: "A's thread" } }))).json());
    h.signIn(userB);

    const foreign = await statusAndBody(await getMessages(created.thread.id, null));
    const missing = await statusAndBody(await getMessages(randomUUID(), null));
    const malformed = await Promise.all(MALFORMED_IDS.map(async (bad) => statusAndBody(await getMessages(bad, null))));

    expect(foreign[0]).toBe(404);
    expect(JSON.parse(foreign[1])).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });
    expect(missing).toEqual(foreign);
    for (const each of malformed) expect(each).toEqual(foreign);

    h.signIn(null);
    const guest = await statusAndBody(await getMessages(created.thread.id, guestCookie().cookie));
    expect(guest).toEqual(foreign);

    h.signIn(userA);
    expect((await getMessages(created.thread.id, null)).status).toBe(200);
  });
});

describe("POST /api/threads — a foreign document is never attached, and a citation naming one is skipped/not_found, never 404", () => {
  it("createThread never throws on a foreign, missing or malformed documentId — it silently skips attachment and unlinks the citation", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const docA = await analyzedDocumentViaRoutes(null);

    h.signIn(userB);
    for (const badId of [docA, randomUUID(), "not-a-uuid"]) {
      const res = await callRoute(
        threadsRoute.POST,
        request("POST", "/api/threads", {
          json: {
            title: "B's thread",
            documentIds: [badId],
            importedMessages: [
              {
                role: "assistant",
                content: "The license fee is Rs. 32,000.",
                mode: "grounded",
                citations: [{ quoteText: LEASE.licenseFee, sourceDocumentId: badId }],
              },
            ],
          },
        }),
      );

      // Never a 404/403 for a bad documentId here — createThread's own rule (docs.ts's `getDocument`
      // NOT_FOUND is caught and the id is simply skipped/unlinked), so this is 200 with the id
      // dropped, not an existence-oracle-style error status.
      expect(res.status).toBe(200);
      const body = ThreadOutput.parse(await res.json());
      expect(body.documentIds).toEqual([]);
      const assistant = body.messages.find((m) => m.role === "assistant");
      if (assistant?.role !== "assistant" || assistant.mode !== "grounded") throw new Error("expected a grounded assistant message");
      expect(assistant.citations).toHaveLength(1);
      expect(assistant.citations[0].verification.status).toBe("not_found");
      expect(assistant.citations[0].sourceDocumentId).toBeNull();
    }

    // Positive control: the SAME request shape (a citation naming docA), but from its real owner,
    // user A — attaches the document for real and the citation comes back genuinely verified,
    // bound to and cut from the stored document.
    h.signIn(userA);
    const ownedRes = await callRoute(
      threadsRoute.POST,
      request("POST", "/api/threads", {
        json: {
          title: "A's thread",
          documentIds: [docA],
          importedMessages: [
            {
              role: "assistant",
              content: "The license fee is Rs. 32,000.",
              mode: "grounded",
              citations: [{ quoteText: LEASE.licenseFee, sourceDocumentId: docA }],
            },
          ],
        },
      }),
    );
    expect(ownedRes.status).toBe(200);
    const owned = ThreadOutput.parse(await ownedRes.json());
    expect(owned.documentIds).toEqual([docA]);
    const ownedAssistant = owned.messages.find((m) => m.role === "assistant");
    if (ownedAssistant?.role !== "assistant" || ownedAssistant.mode !== "grounded") throw new Error("expected a grounded assistant message");
    const verification = ownedAssistant.citations[0].verification;
    expect(verification.status).toBe("verified");
    expect(ownedAssistant.citations[0].sourceDocumentId).toBe(docA);
    if (verification.status !== "verified") throw new Error("unreachable");
    const stored = await h.t.client.query<{ canonical_text: string }>("SELECT canonical_text FROM documents WHERE id = $1", [docA]);
    expect(verification.spanText).toBe(stored.rows[0].canonical_text.slice(verification.spanStart, verification.spanEnd));
    expect(verification.spanText).toBe(LEASE.licenseFee);
  });
});

describe("POST /api/threads/:id/messages — foreign/missing thread id is a 404 error-first stream, never 200", () => {
  it("byte-identical to the JSON 404 a plain route gives; the owner's turn streams normally", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const created = ThreadOutput.parse(await (await callRoute(threadsRoute.POST, request("POST", "/api/threads", { json: { title: "A's thread" } }))).json());
    h.signIn(userB);

    const foreign = await askThread(created.thread.id, null);
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toContain("application/json");
    const foreignBody = await foreign.text();
    expect(JSON.parse(foreignBody)).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });

    const missing = await askThread(randomUUID(), null);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(foreignBody);

    // Malformed ids mirror GET's own malformed-id coverage above.
    const malformed = await Promise.all(MALFORMED_IDS.map(async (bad) => statusAndBody(await askThread(bad, null))));
    for (const each of malformed) expect(each).toEqual([404, foreignBody]);

    // A guest holding no claim to it is denied the same way, mirroring GET's own guest coverage above.
    h.signIn(null);
    const guest = await statusAndBody(await askThread(created.thread.id, guestCookie().cookie));
    expect(guest).toEqual([404, foreignBody]);

    // Positive control: the owner's turn against the same thread streams (never 200-then-404).
    // "hi" routes to general_legal (one specialist call, general mode), so queue that specialist's
    // response — the harness's default Understand-shaped fixture doesn't match {answer, citations}.
    h.signIn(userA);
    h.primary.enqueue({ data: { answer: "This is general information, not a verified answer.", citations: [] } });
    const owned = await askThread(created.thread.id, null);
    expect(owned.status).toBe(200);
    expect(owned.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  });
});
