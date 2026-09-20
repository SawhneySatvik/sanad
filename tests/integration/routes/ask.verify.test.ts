// One Guarantee checks for POST /api/ask, end to end through the real handler: rate limiting,
// token/label shape, spanText binding on a real linked citation, and abort propagation to
// in-flight LLM calls.

import { afterEach, describe, expect, it } from "vitest";
import type { ZodType, z } from "zod";
import * as askRoute from "@/app/api/ask/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { AppError } from "@/server/core/errors";
import { normalizeProviderError } from "@/server/llm/errors";
import { MAX_DOCUMENTS_TOTAL_CHARS } from "@/server/orchestrator/config";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import type { LlmClient, LlmCompleteInput, LlmCompleteResult, LlmStreamEvent } from "@/server/llm/types";
import { LEASE, leaseOutput } from "@tests/support/services/understand";
import { GENERAL_MODE_LABEL } from "@/shared/contracts/threads";
import type { AnalyzeDocumentInput } from "@/shared/contracts/documents";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, FIXED_CLOCK, guestCookie, request, TEST_MODEL_ID, unavailable, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

// A legal-angle query with no document: the general_legal specialist, one streamed LLM call
// (never the zero-call non_legal redirect, which would never touch the rate limiter at all).
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

// A query scoring 2 specialists by text alone (no document needed) — tenancy ("rental agreement")
// + employment ("notice period", "offer letter", "probation") — so the multi-specialist path
// dispatches 2 parallel complete() calls, then (only if both resolve) one streamed synthesis call.
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

// A fully-controlled LlmClient (not FakeLlmClient — whose `hang: true` can't script this shape):
// every complete()/stream() call is recorded with the signal it received. Both specialist calls
// hang until aborted, so the synthesis call is never dispatched — proves "before the first event".
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

// Specialists resolve normally; synthesis streams one token then hangs — proves "after the stream
// opened": the client already has a 200 and a token when it disconnects, and the still-pending
// synthesis call is what must abort.
function hangingSynthesisClient(): { client: LlmClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: LlmClient = {
    capabilities: { structuredOutput: true, nativeDocumentInput: false, streaming: true },
    async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
      calls.push({ signal: input.signal });
      return {
        data: { answer: "specialist answer.", citations: [] } as z.infer<Schema>,
        modelUsed: "hanging-fake",
        tokensUsed: { input: 0, output: 0 },
      };
    },
    async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
      calls.push({ signal: input.signal });
      yield { type: "token", token: '{"answer":"partial' } as LlmStreamEvent<Schema>;
      await hangForever(input.signal);
    },
  };
  return { client, calls };
}

// A "still pending" sentinel so a test never actually awaits an unresolvable promise forever — the
// race always settles within `ms`, whether or not the real promise ever does.
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

// Built directly (not via harness's request()) because it needs an externally abortable signal,
// which request() doesn't expose.
function abortableAskRequest(query: string, cookie: string, signal: AbortSignal): Request {
  return new Request(new URL("/api/ask", "http://localhost"), {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", cookie }),
    body: JSON.stringify({ query }),
    signal,
  });
}

function ask(cookie: string | null) {
  return callRoute(askRoute.POST, request("POST", "/api/ask", { cookie, json: { query: GENERAL_LEGAL_QUERY } }));
}

// Upload + POST /api/documents from raw text, not a fixture on disk — harness.ts's own
// uploadViaRoutes only reads tests/fixtures/documents/**, and this needs an over-budget document
// too large to keep as a committed fixture.
async function uploadTextViaRoutes(cookie: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const targetRes = await callRoute(
    uploadsRoute.POST,
    request("POST", "/api/uploads", { cookie, json: { filename: "big.txt", mimeType: "text/plain", sizeBytes: bytes.byteLength } }),
  );
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as { uploadUrl: string; ref: string };
  const relayRes = await callRoute(uploadsRelayRoute.PUT, request("PUT", target.uploadUrl, { cookie, bytes }));
  expect(relayRes.status).toBe(200);
  const input: AnalyzeDocumentInput = { storageRef: target.ref, filename: "big.txt", mimeType: "text/plain" };
  const docRes = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));
  expect(docRes.status).toBe(200);
  return ((await docRes.json()) as { document: { id: string } }).document.id;
}

// The service's principal-tier check runs as the FIRST thing the orchestrator's LLM call does
// (before any token), so ask()'s first event is `{type:"error", code:"RATE_LIMITED"}` and sse.ts's
// first-event-decides-status rule turns that into the real status before any header is sent.
describe("a rate-limited ask is a real 429, never a 200 stream", () => {
  it("the principal bucket exhausted by a first real call: the second is error-first RATE_LIMITED — 429 JSON, no text/event-stream header, no token", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer."), rateLimits: { principalPerMinute: 1, clock: FIXED_CLOCK } });
    const { cookie } = guestCookie();

    const first = await ask(cookie);
    expect(first.status).toBe(200);
    await first.text(); // drain: the first call's one LLM call is what fills the principal bucket

    const second = await ask(cookie);

    expect(second.status).toBe(429);
    expect(second.status).not.toBe(200);
    expect(second.headers.get("content-type")).toContain("application/json");
    expect(second.headers.get("content-type")).not.toContain("text/event-stream");
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(h.primary.callCount).toBe(1); // the second call never reached the model at all
  });
});

describe("no token frame ever carries a status key", () => {
  it("every token frame is exactly {type, text}", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer for this dispute.") });
    const { cookie } = guestCookie();

    const res = await ask(cookie);
    const frames = parseFrames(await res.text());
    const tokens = frames.filter((f) => f.event === "token");

    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(Object.keys(token.data).sort()).toEqual(["text", "type"]);
    }
    expect(JSON.stringify(tokens)).not.toContain("status");
  });
});

describe("the general-mode label is the fixed string", () => {
  it("a general final message carries GENERAL_MODE_LABEL, never model text, and no status/citations key", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer for this dispute.") });
    const { cookie } = guestCookie();

    const res = await ask(cookie);
    const frames = parseFrames(await res.text());
    const final = frames[frames.length - 1];

    expect(final.event).toBe("final");
    const message = final.data.message as Record<string, unknown>;
    expect(message.mode).toBe("general");
    expect(message.label).toBe(GENERAL_MODE_LABEL);
    expect(Object.keys(message)).not.toContain("citations");
    expect(Object.keys(message)).not.toContain("status");
    expect(Object.keys(message)).not.toContain("verification");
  });
});

describe("a grounded turn on the only reachable Ask path with a real linked citation binds and cuts spanText", () => {
  // Tenancy keyword only ("lease") — avoids a second specialist scoring and fanning out.
  const LICENSE_FEE_QUERY = "What does my lease say about the license fee?";

  it("the final SSE frame's verified citation carries spanText === canonical_text.slice(spanStart, spanEnd) — proven against the STORED document text, not just equal to the model's own quote", async () => {
    h = await createRouteHarness({ primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, responses: [{ data: leaseOutput() }] }) });
    const { cookie } = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(cookie);
    h.primary.enqueue({
      data: { answer: "The license fee is Rs. 32,000.", citations: [{ quote: LEASE.licenseFee, sourceDocumentId: documentId }] },
    });

    const res = await callRoute(
      askRoute.POST,
      request("POST", "/api/ask", { cookie, json: { query: LICENSE_FEE_QUERY, documentIds: [documentId] } }),
    );

    expect(res.status).toBe(200); // a grounded turn must stream normally, never a 500 or a dropped connection
    const text = await res.text();
    const frames = parseFrames(text);
    const final = frames[frames.length - 1];
    expect(final.event).toBe("final");
    const message = final.data.message as {
      mode: string;
      citations: { sourceDocumentId: string; verification: { status: string; spanStart: number; spanEnd: number; spanText: string } }[];
    };
    expect(message.mode).toBe("grounded");
    expect(message.citations).toHaveLength(1);
    expect(message.citations[0].sourceDocumentId).toBe(documentId);
    const verification = message.citations[0].verification;
    expect(verification.status).toBe("verified");

    // Proof it's a real server-side cut of the STORED document, not merely equal to the model's own
    // quote (which would also equal LEASE.licenseFee and pass a weaker `toBe` check).
    const stored = await h.t.client.query<{ canonical_text: string }>("SELECT canonical_text FROM documents WHERE id = $1", [documentId]);
    const canonicalText = stored.rows[0].canonical_text;
    expect(verification.spanText).toBe(canonicalText.slice(verification.spanStart, verification.spanEnd));
    expect(verification.spanText).toBe(LEASE.licenseFee);

    // The whole document text — and any of its OTHER, uncited clauses — never rides the wire.
    expect(text).not.toContain(canonicalText);
    expect(text).not.toContain(LEASE.lockIn);
  });
});

// Must not let them run to completion unobserved against the shared quota. `signal: req.signal`
// is threaded through `route()`'s RunArgs into `askService.ask`.
// Honest errors reach the wire: a pre-stream INVALID_DOCUMENT/grounding_too_long refusal carries its
// reason in the 422 body, and a provider failure mid-turn is surfaced as our own 503
// UPSTREAM_UNAVAILABLE — never a raw provider 429 — with retryAfterSeconds in the error frame.
describe("honest errors: reason and retryAfterSeconds reach the wire", () => {
  it("pre-stream: attached documents whose combined text is over MAX_DOCUMENTS_TOTAL_CHARS are 422 INVALID_DOCUMENT/grounding_too_long, before any Ask model call", async () => {
    // Two documents, each comfortably under Understand's own per-document prompt budget (so each
    // analyzes normally on upload), whose combined canonical text is over the orchestrator's
    // MAX_DOCUMENTS_TOTAL_CHARS once both are attached to one Ask turn.
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: { findings: [] } } }),
    });
    const { cookie } = guestCookie();
    // Each document's own length: comfortably under MODEL_INPUT_BUDGET_CHARS.understand (120,000,
    // the same constant), but the two together are well over MAX_DOCUMENTS_TOTAL_CHARS (120,000).
    const perDocumentChars = Math.ceil(MAX_DOCUMENTS_TOTAL_CHARS * 0.65);
    const padded = (sentence: string) => sentence.repeat(Math.ceil(perDocumentChars / sentence.length)).slice(0, perDocumentChars);
    const first = await uploadTextViaRoutes(cookie, padded("The Licensee shall comply with every clause of this agreement. "));
    // Distinct text (never the cache's identical-text hit) so this second analysis is a real call too.
    const second = await uploadTextViaRoutes(cookie, padded("The Licensor shall honour every term of this instrument. "));
    expect(h.primary.callCount).toBe(2); // spent entirely on the two uploads' own analyses

    const res = await callRoute(
      askRoute.POST,
      request("POST", "/api/ask", { cookie, json: { query: GENERAL_LEGAL_QUERY, documentIds: [first, second] } }),
    );

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT", reason: "grounding_too_long" } });
    expect(h.primary.callCount).toBe(2); // the ask turn itself never reached the model
  });

  it("mid-turn: every fallback tier failing at the provider surfaces as 503 UPSTREAM_UNAVAILABLE, with retryAfterSeconds in the error frame, never the provider's raw 429", async () => {
    // FakeLlmClient.stream() emits the first attempt's raw text as tokens before validating it; an
    // unparseable-as-final prefix that still starts a real JSON "answer" field yields at least one
    // token, so the failure lands mid-stream, never pre-stream.
    const primary = new FakeLlmClient({
      modelUsed: TEST_MODEL_ID,
      responses: [{ rawText: '{"answer":"a partial answer that never finishes' }, { error: normalizeProviderError({ status: 429, message: '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"9s"}]}}' }) }],
    });
    h = await createRouteHarness({ primary });
    const { cookie } = guestCookie();

    const res = await ask(cookie);

    expect(res.status).toBe(200); // the stream already committed on the first (token) event
    const text = await res.text();
    const frames = parseFrames(text);
    expect(frames.some((f) => f.event === "token")).toBe(true);
    const errorFrame = frames.find((f) => f.event === "error");
    expect(errorFrame).toBeDefined();
    expect(errorFrame!.data).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 9 } });
    expect(JSON.stringify(errorFrame!.data)).not.toContain("RATE_LIMITED");
  });
});

describe("a disconnected client aborts the turn's in-flight LLM calls", () => {
  it("(a) abort BEFORE the first event: both specialist calls' signals abort; synthesis is never dispatched; nothing persisted", async () => {
    const { client, calls } = hangingSpecialistsClient();
    h = await createRouteHarness({ providers: () => ({ primary: client, secondary: unavailable() }) });
    const { cookie } = guestCookie();
    const controller = new AbortController();

    const responsePromise = callRoute(askRoute.POST, abortableAskRequest(MULTI_DOMAIN_QUERY, cookie, controller.signal));
    await waitUntil(() => calls.length === 2, 2000); // both specialist complete() calls dispatch (they hang)
    controller.abort();

    const res = await raceAgainst(responsePromise, 2000);
    expect(res).not.toBe(STILL_PENDING);
    if (res === STILL_PENDING) throw new Error("unreachable");
    expect(res.status).toBe(504); // TIMEOUT — the abort propagated as a typed error, first event
    expect(res.status).not.toBe(200);

    expect(calls).toHaveLength(2); // still exactly the 2 specialists — synthesis was never dispatched
    for (const call of calls) expect(call.signal?.aborted).toBe(true);

    const messages = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM messages");
    expect(messages.rows[0].n).toBe(0); // unsaved turn: nothing was ever going to persist regardless
  });

  it("(b) abort AFTER the stream opened: the client already has a 200 and a token; the still-pending synthesis call aborts too", async () => {
    const { client, calls } = hangingSynthesisClient();
    h = await createRouteHarness({ providers: () => ({ primary: client, secondary: unavailable() }) });
    const { cookie } = guestCookie();
    const controller = new AbortController();

    const res = await raceAgainst(callRoute(askRoute.POST, abortableAskRequest(MULTI_DOMAIN_QUERY, cookie, controller.signal)), 2000);
    expect(res).not.toBe(STILL_PENDING);
    if (res === STILL_PENDING) throw new Error("unreachable");
    expect(res.status).toBe(200); // both specialists resolved, synthesis opened the stream

    const reader = res.body!.getReader();
    const first = await raceAgainst(reader.read(), 2000);
    expect(first).not.toBe(STILL_PENDING);
    if (first === STILL_PENDING) throw new Error("unreachable");
    expect(new TextDecoder().decode(first.value)).toContain('"type":"token"');
    expect(calls).toHaveLength(3); // 2 specialists (resolved) + 1 synthesis stream call (still open)
    expect(calls[2].signal?.aborted).toBe(false);

    controller.abort(); // the client disconnects mid-generation, after already having a token

    // The still-pending synthesis call must actually stop — proven by its OWN signal, not merely by
    // the read eventually settling (which `.return()`/cancel() alone cannot guarantee).
    const settled = await raceAgainst(
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return "closed";
        }
      })(),
      2000,
    );
    expect(settled).not.toBe(STILL_PENDING); // the stream actually ends, not left hanging forever
    expect(calls[2].signal?.aborted).toBe(true);
  });
});
