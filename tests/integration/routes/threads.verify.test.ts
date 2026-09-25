// One Guarantee checks for the threads routes, end to end through the real handlers: forged
// citation rejection, general-mode/token frame shape, spanText binding on a real linked citation,
// and abort propagation to a saved thread's in-flight LLM calls.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import * as messagesRoute from "@/app/api/threads/[id]/messages/route";
import * as threadsRoute from "@/app/api/threads/route";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import type { LlmClient, LlmCompleteInput, LlmCompleteResult, LlmStreamEvent } from "@/server/llm/types";
import { LEASE, leaseOutput } from "@tests/support/services/understand";
import { MessagesOutput, ThreadOutput } from "@/shared/contracts/threads";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, request, TEST_MODEL_ID, unavailable, userA, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

const GENERAL_LEGAL_QUERY = "Do I need a lawyer for this dispute?";

function askPrimary(answer: string): FakeLlmClient {
  return new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: { answer, citations: [] } } });
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

// A query scoring 2 specialists by text alone — tenancy ("rental agreement") + employment ("notice
// period", "offer letter", "probation") — so the multi-specialist path dispatches 2 parallel
// complete() calls before any synthesis.
const MULTI_DOMAIN_QUERY = "my rental agreement notice period and my employment offer letter probation period";

interface RecordedCall {
  signal?: AbortSignal;
}

function hangForever(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    // The signal may already be aborted by the time this call is dispatched (a real race under
    // load) — "abort" only fires on a FUTURE transition, so checking first avoids hanging forever
    // waiting for an event that already happened.
    if (signal?.aborted) {
      reject(new AppError("TIMEOUT", "aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new AppError("TIMEOUT", "aborted")), { once: true });
  });
}

// A fully-controlled LlmClient whose specialist calls hang until aborted (see ask.verify.test.ts's
// own copy for the full rationale — FakeLlmClient's `hang: true` can't script this shape).
function hangingSpecialistsClient(): { client: LlmClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: LlmClient = {
    capabilities: { structuredOutput: true, nativeDocumentInput: false, streaming: true },
    async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
      calls.push({ signal: input.signal });
      return hangForever(input.signal);
    },
    async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
      calls.push({ signal: input.signal });
      await hangForever(input.signal);
    },
  };
  return { client, calls };
}

const STILL_PENDING = Symbol("still-pending");
function raceAgainst<T>(promise: Promise<T>, ms: number): Promise<T | typeof STILL_PENDING> {
  return Promise.race([promise, new Promise<typeof STILL_PENDING>((resolve) => setTimeout(() => resolve(STILL_PENDING), ms))]);
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls until `predicate()` is true, instead of a fixed delay guessing how long dispatch takes
// (a fixed delay is flaky under load). Throws if it never becomes true within `ms`, so a genuine
// failure still fails fast and loud, never hangs.
async function waitUntil(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitUntil: condition not met within ${ms}ms`);
    await delay(5);
  }
}

// Built directly (not via harness's request()), which doesn't expose an externally abortable signal.
function abortableAskThreadRequest(threadId: string, query: string, signal: AbortSignal): Request {
  return new Request(new URL(`/api/threads/${threadId}/messages`, "http://localhost"), {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ query }),
    signal,
  });
}

describe("a forged verified citation, imported over a document the importer can't reach, comes back not_found", () => {
  it("createThread's import discards the client's status/unverifiedCachedStatus and stores the citation unlinked; GET re-verifies it as not_found", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const foreignDocumentId = randomUUID(); // never uploaded by anyone — the strongest possible forgery

    const res = await callRoute(
      threadsRoute.POST,
      request("POST", "/api/threads", {
        json: {
          title: "Imported from a guest session",
          importedMessages: [
            { role: "user", content: "What does the contract say about the deposit?" },
            {
              role: "assistant",
              content: "The deposit is fully refundable within 15 days.",
              mode: "grounded",
              modelUsed: "gemini-2.5-flash",
              citations: [
                {
                  quoteText: "The deposit is fully refundable within 15 days.",
                  sourceDocumentId: foreignDocumentId,
                  // Exactly what a devtools-forged / stale guest-store payload carries — every one
                  // of these must be discarded; no client-supplied verification field is ever trusted.
                  status: "verified",
                  unverifiedCachedStatus: "cached_verified",
                  spanStart: 0,
                  spanEnd: 10,
                },
              ],
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    const created = ThreadOutput.parse(await res.json());
    // createThread's own response already carries the re-verified read.
    const assistant = created.messages.find((m) => m.role === "assistant");
    expect(assistant?.role).toBe("assistant");
    if (assistant?.role !== "assistant" || assistant.mode !== "grounded") throw new Error("expected a grounded assistant message");
    expect(assistant.citations).toHaveLength(1);
    expect(assistant.citations[0].verification).toMatchObject({ status: "not_found", spanStart: null, spanEnd: null, spanText: null });
    expect(assistant.citations[0].sourceDocumentId).toBeNull();
    expect(JSON.stringify(assistant.citations[0])).not.toContain("cached_verified");
    // No top-level quote/model-text field on the wire citation.
    expect(Object.keys(assistant.citations[0]).sort()).toEqual(["id", "inputMode", "sourceDocumentId", "verification"]);
    // Discarded to unlinked (the cited document is foreign): no real document to report a mode for.
    expect(assistant.citations[0].inputMode).toBeNull();

    // Independently, through GET /api/threads/:id/messages too — never trusting a cached read.
    const listed = MessagesOutput.parse(
      await (await callRoute(messagesRoute.GET, request("GET", `/api/threads/${created.thread.id}/messages`), { id: created.thread.id })).json(),
    );
    const listedAssistant = listed.messages.find((m) => m.role === "assistant");
    if (listedAssistant?.role !== "assistant" || listedAssistant.mode !== "grounded") throw new Error("expected a grounded assistant message");
    expect(listedAssistant.citations[0].verification).toMatchObject({ status: "not_found", spanStart: null, spanEnd: null, spanText: null });
    expect(listedAssistant.citations[0].sourceDocumentId).toBeNull();
  });
});

describe("a general-mode final frame has no status/citation/verification key anywhere", () => {
  it("POST /api/threads/:id/messages — the final frame's raw text carries no such key", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer for this.") });
    h.signIn(userA);
    const created = ThreadOutput.parse(await (await callRoute(threadsRoute.POST, request("POST", "/api/threads", { json: { title: "Chat" } }))).json());

    const res = await callRoute(
      messagesRoute.POST,
      request("POST", `/api/threads/${created.thread.id}/messages`, { json: { query: GENERAL_LEGAL_QUERY } }),
      { id: created.thread.id },
    );
    const text = await res.text();
    const frames = parseFrames(text);

    expect(frames.every((f) => f.event !== "token" || Object.keys(f.data).sort().join(",") === "text,type")).toBe(true);
    const final = frames[frames.length - 1];
    expect(final.event).toBe("final");
    expect(final.data.message).toMatchObject({ mode: "general" });
    expect(JSON.stringify(final.data)).not.toContain("status");
    expect(JSON.stringify(final.data)).not.toContain("citations");
    expect(JSON.stringify(final.data)).not.toContain("verification");
  });
});

// Tenancy keywords only ("lease") — "rental agreement"/"notice period" would also score a second
// specialist and fan out to the multi-specialist path instead of the single streamed/complete() call
// these tests are scripted for.
const LICENSE_FEE_QUERY = "What does my lease say about the license fee?";

describe("a real linked citation binds and cuts spanText — POST /api/threads import", () => {
  it("importing a citation over a document the signing-in user owns: 200, spanText is the canonical slice, exactly one thread created (no persist-then-500, so no retry-duplication risk)", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const documentId = await analyzedDocumentViaRoutes(null);

    const res = await callRoute(
      threadsRoute.POST,
      request("POST", "/api/threads", {
        json: {
          title: "Lease import",
          documentIds: [documentId],
          importedMessages: [
            {
              role: "assistant",
              content: "The license fee is Rs. 32,000.",
              mode: "grounded",
              modelUsed: "gemini-2.5-flash",
              citations: [{ quoteText: LEASE.licenseFee, sourceDocumentId: documentId }],
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    const rawBody = await res.text();
    const body = ThreadOutput.parse(JSON.parse(rawBody));
    expect(body.documentIds).toEqual([documentId]);
    const assistant = body.messages.find((m) => m.role === "assistant");
    if (assistant?.role !== "assistant" || assistant.mode !== "grounded") throw new Error("expected a grounded assistant message");
    expect(assistant.citations).toHaveLength(1);
    const verification = assistant.citations[0].verification;
    expect(verification.status).toBe("verified");
    expect(assistant.citations[0].sourceDocumentId).toBe(documentId);

    // Proof it's a real server-side cut of the STORED document, not merely equal to the imported
    // quote (which would also equal LEASE.licenseFee and pass a weaker `toBe` check).
    const stored = await h.t.client.query<{ canonical_text: string }>("SELECT canonical_text FROM documents WHERE id = $1", [documentId]);
    const canonicalText = stored.rows[0].canonical_text;
    if (verification.status !== "verified") throw new Error("unreachable");
    expect(verification.spanText).toBe(canonicalText.slice(verification.spanStart, verification.spanEnd));
    expect(verification.spanText).toBe(LEASE.licenseFee);

    // The whole document text — and any of its OTHER, uncited clauses — never rides the wire.
    expect(rawBody).not.toContain(canonicalText);
    expect(rawBody).not.toContain(LEASE.lockIn);

    const threads = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM threads");
    expect(threads.rows[0].n).toBe(1);
  });
});

describe("a saved-thread ask turn binds and cuts spanText, then GET reads it back the same way", () => {
  it("POST /api/threads/:id/messages then GET: both 200, both carry the exact canonical-slice spanText", async () => {
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, responses: [{ data: leaseOutput() }] }),
    });
    h.signIn(userA);
    const documentId = await analyzedDocumentViaRoutes(null);
    // Queued only now that documentId is known — the citation must name the real id.
    h.primary.enqueue({
      data: { answer: "The license fee is Rs. 32,000.", citations: [{ quote: LEASE.licenseFee, sourceDocumentId: documentId }] },
    });
    const created = ThreadOutput.parse(
      await (await callRoute(threadsRoute.POST, request("POST", "/api/threads", { json: { title: "Lease", documentIds: [documentId] } }))).json(),
    );

    const stored = await h.t.client.query<{ canonical_text: string }>("SELECT canonical_text FROM documents WHERE id = $1", [documentId]);
    const canonicalText = stored.rows[0].canonical_text;

    const askRes = await callRoute(
      messagesRoute.POST,
      request("POST", `/api/threads/${created.thread.id}/messages`, { json: { query: LICENSE_FEE_QUERY } }),
      { id: created.thread.id },
    );
    expect(askRes.status).toBe(200);
    const sseText = await askRes.text();
    const frames = parseFrames(sseText);
    const final = frames[frames.length - 1];
    expect(final.event).toBe("final");
    const message = final.data.message as {
      citations: { verification: { status: string; spanStart: number; spanEnd: number; spanText: string } }[];
    };
    expect(message.citations).toHaveLength(1);
    const sseVerification = message.citations[0].verification;
    expect(sseVerification.status).toBe("verified");
    // Proof it's a real server-side cut of the STORED document, not merely echoed model text.
    expect(sseVerification.spanText).toBe(canonicalText.slice(sseVerification.spanStart, sseVerification.spanEnd));
    expect(sseVerification.spanText).toBe(LEASE.licenseFee);
    expect(sseText).not.toContain(canonicalText);
    expect(sseText).not.toContain(LEASE.lockIn);

    const getRes = await callRoute(messagesRoute.GET, request("GET", `/api/threads/${created.thread.id}/messages`), { id: created.thread.id });
    expect(getRes.status).toBe(200);
    const getText = await getRes.text();
    const listed = MessagesOutput.parse(JSON.parse(getText));
    const assistant = listed.messages.find((m) => m.role === "assistant");
    if (assistant?.role !== "assistant" || assistant.mode !== "grounded") throw new Error("expected a grounded assistant message");
    const getVerification = assistant.citations[0].verification;
    expect(getVerification.status).toBe("verified");
    if (getVerification.status !== "verified") throw new Error("unreachable");
    expect(getVerification.spanText).toBe(canonicalText.slice(getVerification.spanStart, getVerification.spanEnd));
    expect(getVerification.spanText).toBe(LEASE.licenseFee);
    expect(getText).not.toContain(canonicalText);
    expect(getText).not.toContain(LEASE.lockIn);
  });
});

describe("a verified citation whose model quote has irregular padding never leaks that raw string, in SSE or GET", () => {
  const MESSY_QUOTE = "   Rs.     32,000/-   ";

  it("the padded raw quote appears nowhere in the SSE final frame's bytes, nor in a subsequent GET's bytes — only the clean spanText does", async () => {
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, responses: [{ data: leaseOutput() }] }),
    });
    h.signIn(userA);
    const documentId = await analyzedDocumentViaRoutes(null);
    h.primary.enqueue({ data: { answer: "The fee is Rs. 32,000/-.", citations: [{ quote: MESSY_QUOTE, sourceDocumentId: documentId }] } });
    const created = ThreadOutput.parse(
      await (await callRoute(threadsRoute.POST, request("POST", "/api/threads", { json: { title: "Lease", documentIds: [documentId] } }))).json(),
    );

    const askRes = await callRoute(
      messagesRoute.POST,
      request("POST", `/api/threads/${created.thread.id}/messages`, { json: { query: LICENSE_FEE_QUERY } }),
      { id: created.thread.id },
    );
    const sseText = await askRes.text();
    expect(askRes.status).toBe(200);
    expect(sseText).not.toContain(MESSY_QUOTE);
    expect(sseText).not.toContain("     32,000"); // the quote's own irregular internal spacing

    const frames = parseFrames(sseText);
    const sseMessage = frames[frames.length - 1].data.message as { citations: { verification: { status: string; spanText: string } }[] };
    expect(sseMessage.citations[0].verification.status).toBe("verified");
    const spanText = sseMessage.citations[0].verification.spanText;
    // The clean, server-cut span itself has none of the messy quote's padding.
    expect(spanText).not.toMatch(/^\s|\s{2,}|\s$/);
    // Positive control: the clean span IS what's shown, on both surfaces — never the padded quote.
    expect(sseText).toContain(spanText);

    const getRes = await callRoute(messagesRoute.GET, request("GET", `/api/threads/${created.thread.id}/messages`), { id: created.thread.id });
    const getText = await getRes.text();
    expect(getRes.status).toBe(200);
    expect(getText).not.toContain(MESSY_QUOTE);
    expect(getText).not.toContain("     32,000");
    const listed = MessagesOutput.parse(JSON.parse(getText));
    const getAssistant = listed.messages.find((m) => m.role === "assistant");
    if (getAssistant?.role !== "assistant" || getAssistant.mode !== "grounded") throw new Error("expected a grounded assistant message");
    expect(getAssistant.citations[0].verification.status).toBe("verified");
    expect(getText).toContain(spanText);
  });
});

// `signal: req.signal` is threaded through `route()`'s RunArgs into `askService.ask`.
describe("a disconnected client aborts a SAVED thread's in-flight LLM calls, and nothing persists", () => {
  it("abort before the first event: both specialist signals abort, synthesis never dispatched, no message/citation rows written", async () => {
    const { client, calls } = hangingSpecialistsClient();
    h = await createRouteHarness({ providers: () => ({ primary: client, secondary: unavailable() }) });
    h.signIn(userA);
    const created = ThreadOutput.parse(await (await callRoute(threadsRoute.POST, request("POST", "/api/threads", { json: { title: "Chat" } }))).json());
    const controller = new AbortController();

    const responsePromise = callRoute(
      messagesRoute.POST,
      abortableAskThreadRequest(created.thread.id, MULTI_DOMAIN_QUERY, controller.signal),
      { id: created.thread.id },
    );
    await waitUntil(() => calls.length === 2, 2000); // both specialist complete() calls dispatch (they hang)
    controller.abort();

    const res = await raceAgainst(responsePromise, 2000);
    expect(res).not.toBe(STILL_PENDING);
    if (res === STILL_PENDING) throw new Error("unreachable");
    expect(res.status).toBe(504); // TIMEOUT — the abort propagated as a typed error, first event
    expect(res.status).not.toBe(200);

    expect(calls).toHaveLength(2); // synthesis was never dispatched
    for (const call of calls) expect(call.signal?.aborted).toBe(true);

    // Nothing persisted: not the user's message, not an assistant row, not a citation — a failed/
    // abandoned turn leaves the thread exactly as it was (ask.ts's own header rule).
    const messages = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE thread_id = $1", [created.thread.id]);
    expect(messages.rows[0].n).toBe(0);
    const citations = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM message_citations");
    expect(citations.rows[0].n).toBe(0);
  });
});
