// POST /api/ask — the unsaved-turn Ask endpoint (docs/API.md's guest note). The 2xx paths, and
// provider exhaustion (every fallback tier open), end to end through the real route handler.

import { afterEach, describe, expect, it } from "vitest";
import * as askRoute from "@/app/api/ask/route";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { CircuitBreaker, FAILURE_THRESHOLD } from "@/server/llm/circuit-breaker";
import { normalizeProviderError } from "@/server/llm/errors";
import { FallbackLlmClient } from "@/server/llm/fallback";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { leaseOutput } from "@tests/support/services/understand";
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

const GENERAL_LEGAL_QUERY = "Do I need a lawyer for this dispute?";
const NON_LEGAL_QUERY = "write me a short poem about the rain";
// Tenancy keywords only ("lease", "security deposit") — "rental agreement" would also score
// contracts_nda's generic "agreement" keyword and fan out to the multi-specialist path instead of
// the single streamed call this test exercises.
const TENANCY_QUERY = "What does my lease say about the security deposit?";

function askPrimary(answer: string, citations: readonly { quote: string; sourceDocumentId: string }[] = []): FakeLlmClient {
  return new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: { answer, citations } } });
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

function ask(cookie: string | null, json: unknown) {
  return callRoute(askRoute.POST, request("POST", "/api/ask", { cookie, json }));
}

describe("POST /api/ask — a guest with no thread", () => {
  it("a general (non-redirect) turn: 200 text/event-stream, tokens then one final frame, nothing persisted", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer for this.") });
    const { cookie } = guestCookie();

    const res = await ask(cookie, { query: GENERAL_LEGAL_QUERY });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const frames = parseFrames(await res.text());
    expect(frames.slice(0, -1).every((f) => f.event === "token")).toBe(true);
    const last = frames[frames.length - 1];
    expect(last.event).toBe("final");
    const message = last.data.message as Record<string, unknown>;
    expect(message.mode).toBe("general");
    expect(message.id).toBeNull(); // unsaved: nothing persisted
    expect(message.createdAt).toBeNull();
    expect(h.primary.callCount).toBe(1);

    const threads = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM threads");
    expect(threads.rows[0].n).toBe(0);
    const messages = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM messages");
    expect(messages.rows[0].n).toBe(0);
  });

  it("a redirected (non-legal) turn: zero LLM calls, mode general, redirect true", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();

    const res = await ask(cookie, { query: NON_LEGAL_QUERY });

    expect(res.status).toBe(200);
    const frames = parseFrames(await res.text());
    const last = frames[frames.length - 1];
    const message = last.data.message as Record<string, unknown>;
    expect(message.mode).toBe("general");
    expect(message.redirect).toBe(true);
    expect(h.primary.callCount).toBe(0);
  });

  it("a grounded turn (document attached) whose specialist claims no citations: mode grounded, citations []", async () => {
    // Queue: the document's own analysis (understand.analyze, a complete() call, Understand's
    // {findings} shape) consumes the first entry; the ask() turn's single-specialist stream()
    // call consumes the second ({answer, citations} shape).
    h = await createRouteHarness({
      primary: new FakeLlmClient({
        modelUsed: TEST_MODEL_ID,
        responses: [{ data: leaseOutput() }, { data: { answer: "The notice period is one month.", citations: [] } }],
      }),
    });
    const { cookie } = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(cookie);

    const res = await ask(cookie, { query: TENANCY_QUERY, documentIds: [documentId] });

    expect(res.status).toBe(200);
    const frames = parseFrames(await res.text());
    const last = frames[frames.length - 1];
    const message = last.data.message as Record<string, unknown>;
    expect(message.mode).toBe("grounded");
    expect(message.citations).toEqual([]);
    expect(h.primary.callCount).toBe(2); // one for the document upload's own analysis, one for the ask
  });

  it("a user (no saved thread yet) can also call this endpoint", async () => {
    h = await createRouteHarness({ primary: askPrimary("You may want to consult a lawyer for this.") });
    h.signIn(userA);

    const res = await ask(null, { query: GENERAL_LEGAL_QUERY });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/ask — provider exhaustion (every fallback tier open)", () => {
  // Never scripted with a response: if the chain called through to either tier anyway, this throws
  // its own distinctive "no scripted response" error, failing the test loudly rather than silently
  // answering with something.
  function neverCalled(): FakeLlmClient {
    return new FakeLlmClient();
  }

  it("both tiers' breakers open: 503 UPSTREAM_UNAVAILABLE, never 429, with retry-after the chain's minimum remaining window", async () => {
    const now = Date.now();
    const primaryBreaker = new CircuitBreaker("gemini:primary", { now: () => now, openMs: 20_000 });
    const secondaryBreaker = new CircuitBreaker("gemma:primary", { now: () => now, openMs: 5_000 }); // shorter — the true minimum
    const outage = () => new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE"));
    for (let i = 0; i < FAILURE_THRESHOLD; i++) primaryBreaker.recordFailure(outage());
    for (let i = 0; i < FAILURE_THRESHOLD; i++) secondaryBreaker.recordFailure(outage());
    const primary = new FallbackLlmClient({ client: neverCalled(), breaker: primaryBreaker });
    const secondary = new FallbackLlmClient({ client: neverCalled(), breaker: secondaryBreaker });
    h = await createRouteHarness({ providers: () => ({ primary, secondary }) });
    const { cookie } = guestCookie();

    const res = await ask(cookie, { query: GENERAL_LEGAL_QUERY });

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 5 } });
  });

  it("both tiers open on a provider's own 429: still 503, the provider's RATE_LIMITED never reaches the client", async () => {
    const now = Date.now();
    // A single 429 naming an 8s RetryInfo delay opens the breaker immediately (circuit-breaker.ts's
    // own quota-window rule) for a much longer window (max(OPEN_MS, 8s) = 60s) — its remaining time
    // stays far above 8s, so the stated delay itself is what must surface, as the floor.
    const primaryBreaker = new CircuitBreaker("gemini:primary", { now: () => now });
    primaryBreaker.recordFailure(
      normalizeProviderError({
        status: 429,
        message: JSON.stringify({ error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "8s" }] } }),
      }),
    );
    // A much shorter window than the primary's stated delay, to prove the floor isn't just "the
    // shortest remaining window" by coincidence.
    const secondaryBreaker = new CircuitBreaker("gemma:primary", { now: () => now, openMs: 2_000 });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) secondaryBreaker.recordFailure(new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE")));
    const primary = new FallbackLlmClient({ client: neverCalled(), breaker: primaryBreaker });
    const secondary = new FallbackLlmClient({ client: neverCalled(), breaker: secondaryBreaker });
    h = await createRouteHarness({ providers: () => ({ primary, secondary }) });
    const { cookie } = guestCookie();

    const res = await ask(cookie, { query: GENERAL_LEGAL_QUERY });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("8");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("RATE_LIMITED");
  });
});
