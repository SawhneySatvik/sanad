// POST /api/threads, GET/POST /api/threads/:id/messages — the 2xx paths, end to end through the
// real route handlers over real PGlite + FakeLlmClient.

import { afterEach, describe, expect, it } from "vitest";
import * as messagesRoute from "@/app/api/threads/[id]/messages/route";
import * as threadsRoute from "@/app/api/threads/route";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import {
  MAX_CONTEXT_DOCUMENTS,
  MAX_IMPORTED_CITATIONS,
  MAX_IMPORTED_MESSAGES,
  MAX_IMPORTED_MESSAGE_CHARS,
  MAX_QUOTE_CHARS,
  MAX_THREAD_TITLE_CHARS,
  MessagesOutput,
  ThreadOutput,
} from "@/shared/contracts/threads";
import {
  analyzedDocumentViaRoutes,
  callRoute,
  createRouteHarness,
  guestCookie,
  request,
  TEST_MODEL_ID,
  userA,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

// A query with a legal-angle indicator (classify.ts's GENERAL_LEGAL_ANGLE_INDICATORS) but no
// attached document: routes to the general_legal specialist, one streamed LLM call, mode "general"
// (not the zero-LLM-call non_legal redirect).
const GENERAL_LEGAL_QUERY = "Do I need a lawyer for this dispute?";
const NON_LEGAL_QUERY = "write me a short poem about the rain";

// The harness's own default primary answers Understand's shape ({findings: [...]}) — Ask's
// orchestrator needs specialistOutputSchema's shape ({answer, citations}) instead.
function askPrimary(answer: string, citations: readonly { quote: string; sourceDocumentId: string }[] = []): FakeLlmClient {
  return new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: { answer, citations } } });
}

function createThread(cookie: string | null, json: unknown) {
  return callRoute(threadsRoute.POST, request("POST", "/api/threads", { cookie, json }));
}
function getMessages(id: string, cookie: string | null, query = "") {
  return callRoute(messagesRoute.GET, request("GET", `/api/threads/${id}/messages${query}`, { cookie }), { id });
}
function askThread(id: string, cookie: string | null, query: string) {
  return callRoute(messagesRoute.POST, request("POST", `/api/threads/${id}/messages`, { cookie, json: { query } }), { id });
}

interface Frame {
  event: string;
  data: Record<string, unknown>;
}
function parseFrames(text: string): Frame[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [eventLine, dataLine] = chunk.split("\n");
      return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) as Record<string, unknown> };
    });
}

describe("POST /api/threads — user principal only", () => {
  it("creates an empty thread (no import): messages is [], the response fits ThreadOutput", async () => {
    h = await createRouteHarness();
    h.signIn(userA);

    const res = await createThread(null, { title: "Lease questions" });

    expect(res.status).toBe(200);
    const body = ThreadOutput.parse(await res.json());
    expect(body.thread.title).toBe("Lease questions");
    expect(body.messages).toEqual([]);
    expect(body.documentIds).toEqual([]);
    expect(Object.keys(body.thread)).not.toContain("ownerUserId");
  });

  it("attaches documentIds the principal owns", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const documentId = await analyzedDocumentViaRoutes(null);

    const res = await createThread(null, { title: "With a document", documentIds: [documentId] });

    expect(res.status).toBe(200);
    const body = ThreadOutput.parse(await res.json());
    expect(body.documentIds).toEqual([documentId]);
  });

  it("a guest cannot create a thread — the service's typed VALIDATION_FAILED, mapped to 400, nothing created", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();

    const res = await createThread(cookie, { title: "Guest thread" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    const count = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM threads");
    expect(count.rows[0].n).toBe(0);
  });
});

describe("POST /api/threads — the body cap fits the largest contract-valid import", () => {
  it("a title, documentIds and importedMessages each at their schema maximum (200 messages x 20,000 chars, 100 citations total) is accepted, not 400'd by the body cap", async () => {
    h = await createRouteHarness();
    h.signIn(userA);

    const citation = { quoteText: "Q".repeat(MAX_QUOTE_CHARS), sourceDocumentId: "d".repeat(255) };
    const importedMessages = Array.from({ length: MAX_IMPORTED_MESSAGES }, (_, i) => ({
      role: "assistant" as const,
      content: "C".repeat(MAX_IMPORTED_MESSAGE_CHARS),
      mode: "grounded" as const,
      modelUsed: "m".repeat(64),
      // All MAX_IMPORTED_CITATIONS citations on the first message alone — schema-valid (the
      // per-message array cap is the same number) and exercises the full citations byte budget.
      citations: i === 0 ? Array.from({ length: MAX_IMPORTED_CITATIONS }, () => citation) : [],
    }));
    const body = {
      title: "T".repeat(MAX_THREAD_TITLE_CHARS),
      documentIds: Array.from({ length: MAX_CONTEXT_DOCUMENTS }, () => "d".repeat(255)),
      importedMessages,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect(bytes).toBeGreaterThan(1024 * 1024); // over route()'s 1 MiB default — the case this fixes

    const res = await createThread(null, body);

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(400);
    const parsed = ThreadOutput.parse(await res.json());
    expect(parsed.messages).toHaveLength(MAX_IMPORTED_MESSAGES);
  }, 30_000);
});

describe("POST /api/threads/:id/messages — streamed Ask on a saved thread", () => {
  it("a general (non-redirect) turn: 200 text/event-stream, token frames then one final frame, then persisted and readable via GET", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer for this.") });
    h.signIn(userA);
    const created = ThreadOutput.parse(await (await createThread(null, { title: "General chat" })).json());

    const res = await askThread(created.thread.id, null, GENERAL_LEGAL_QUERY);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const frames = parseFrames(await res.text());
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.slice(0, -1).every((f) => f.event === "token")).toBe(true);
    const last = frames[frames.length - 1];
    expect(last.event).toBe("final");
    const message = last.data.message as Record<string, unknown>;
    expect(message.mode).toBe("general");
    expect(message.redirect).toBe(false);
    expect(message.label).toBe("General information, not verified against a document.");
    expect(h.primary.callCount).toBe(1);

    const listed = MessagesOutput.parse(await (await getMessages(created.thread.id, null)).json());
    expect(listed.messages).toHaveLength(2);
    expect(listed.messages[0].role).toBe("user");
    expect(listed.messages[1].role).toBe("assistant");
  });

  it("a redirected (non-legal) turn: zero LLM calls, mode general, redirect true", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const created = ThreadOutput.parse(await (await createThread(null, { title: "Off-topic" })).json());

    const res = await askThread(created.thread.id, null, NON_LEGAL_QUERY);

    expect(res.status).toBe(200);
    const frames = parseFrames(await res.text());
    const last = frames[frames.length - 1];
    expect(last.event).toBe("final");
    const message = last.data.message as Record<string, unknown>;
    expect(message.mode).toBe("general");
    expect(message.redirect).toBe(true);
    expect(message.modelUsed).toBe("none");
    expect(h.primary.callCount).toBe(0);
  });
});

describe("GET /api/threads/:id/messages", () => {
  it("limit query is validated by ListMessagesInput and honored", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer for this.") });
    h.signIn(userA);
    const created = ThreadOutput.parse(await (await createThread(null, { title: "Chat" })).json());
    // The stream must be fully drained for the turn to persist — completeTurn runs when the
    // consumer pulls past the last token event, per ask.ts's own header.
    await (await askThread(created.thread.id, null, GENERAL_LEGAL_QUERY)).text();

    const res = await getMessages(created.thread.id, null, "?limit=1");
    expect(res.status).toBe(200);
    const body = MessagesOutput.parse(await res.json());
    expect(body.messages).toHaveLength(1);

    const badLimit = await getMessages(created.thread.id, null, "?limit=0");
    expect(badLimit.status).toBe(400);
  });
});
