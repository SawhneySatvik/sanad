// The SSE helper (./sse.ts) through route({ events }): the first event decides the HTTP status
// before any header is sent; later failures become one error frame; the iterator is always closed.

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import { notFound } from "@/server/core/errors";
import { callRoute, createRouteHarness, request, type RouteHarness } from "@tests/integration/routes/harness";
import { INTERNAL_ERROR_MESSAGE } from "@/server/http/errors";
import { route } from "@/server/http/handler";

const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({ type: z.literal("final"), answer: z.string() }),
]);

let h: RouteHarness;
let spies: MockInstance[] = [];
afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  await h.close();
});

function captureLogs(): () => string {
  spies = (["error", "warn", "log"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
  return () => spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" "))).join("\n");
}

// A service-shaped async generator that records how far it was pulled and whether it was closed.
function source(items: (unknown | (() => never))[]) {
  const state = { pulled: 0, closed: false };
  async function* generate() {
    try {
      for (const item of items) {
        state.pulled++;
        yield typeof item === "function" ? (item as () => never)() : item;
      }
    } finally {
      state.closed = true;
    }
  }
  return { state, events: generate() };
}

function streamRoute(events: AsyncIterable<unknown>) {
  return route({ events: Event, run: () => events });
}

describe("the first event decides the status", () => {
  it("error first: the real status and a JSON error body, never 200 text/event-stream; the iterator is closed", async () => {
    h = await createRouteHarness();
    const { state, events } = source([{ type: "error", code: "RATE_LIMITED" }, { type: "token", text: "never" }]);

    const res = await callRoute(streamRoute(events), request("POST", "/api/test"));

    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
    });
    expect(state).toEqual({ pulled: 1, closed: true });
  });

  it("error first with reason and retryAfterSeconds: both land in the pre-stream JSON body and the Retry-After header", async () => {
    h = await createRouteHarness();
    const { events } = source([{ type: "error", code: "INVALID_DOCUMENT", reason: "grounding_too_long", retryAfterSeconds: 12 }]);

    const res = await callRoute(streamRoute(events), request("POST", "/api/test"));

    expect(res.status).toBe(422);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(await res.json()).toMatchObject({
      error: { code: "INVALID_DOCUMENT", reason: "grounding_too_long", retryAfterSeconds: 12 },
    });
  });

  it("error first NOT_FOUND is byte-identical to a JSON route's 404", async () => {
    h = await createRouteHarness();
    const { events } = source([{ type: "error", code: "NOT_FOUND" }]);
    const json = route({
      response: Event,
      run: async () => {
        throw notFound();
      },
    });

    const streamed = await callRoute(streamRoute(events), request("POST", "/api/test"));
    const plain = await callRoute(json, request("POST", "/api/test"));

    expect([streamed.status, await streamed.text()]).toEqual([404, await plain.text()]);
  });

  it("token first: 200 text/event-stream, every event in order through the event contract", async () => {
    h = await createRouteHarness();
    const { state, events } = source([
      { type: "token", text: "Hello" },
      { type: "token", text: " world", status: "verified" },
      { type: "final", answer: "Hello world" },
    ]);

    const res = await callRoute(streamRoute(events), request("POST", "/api/test"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await res.text()).toBe(
      'event: token\ndata: {"type":"token","text":"Hello"}\n\n' +
        // A key the contract does not name never reaches the stream.
        'event: token\ndata: {"type":"token","text":" world"}\n\n' +
        'event: final\ndata: {"type":"final","answer":"Hello world"}\n\n',
    );
    expect(state.closed).toBe(true);
  });

  it("a stream that ends before its first event is a 500", async () => {
    h = await createRouteHarness();
    captureLogs();

    const res = await callRoute(streamRoute(source([]).events), request("POST", "/api/test"));

    expect(res.status).toBe(500);
  });
});

describe("after the first event", () => {
  it("an error event becomes one error frame, the stream ends and nothing after it is pulled", async () => {
    h = await createRouteHarness();
    captureLogs();
    const { state, events } = source([
      { type: "token", text: "partial" },
      { type: "error", code: "UPSTREAM_UNAVAILABLE" },
      { type: "token", text: "never" },
    ]);

    const res = await callRoute(streamRoute(events), request("POST", "/api/test"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      'event: token\ndata: {"type":"token","text":"partial"}\n\n' +
        'event: error\ndata: {"error":{"code":"UPSTREAM_UNAVAILABLE","message":"A required service is temporarily unavailable. Please try again later."}}\n\n',
    );
    expect(state).toEqual({ pulled: 2, closed: true });
  });

  it("a mid-stream error event with reason and retryAfterSeconds carries both in its error frame, for both 429 and 503", async () => {
    h = await createRouteHarness();
    captureLogs();
    const rateLimited = source([{ type: "token", text: "a" }, { type: "error", code: "RATE_LIMITED", retryAfterSeconds: 45 }]);
    const unavailable = source([{ type: "token", text: "a" }, { type: "error", code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 30 }]);

    const rateLimitedText = await (await callRoute(streamRoute(rateLimited.events), request("POST", "/api/test"))).text();
    expect(rateLimitedText).toBe(
      'event: token\ndata: {"type":"token","text":"a"}\n\n' +
        'event: error\ndata: {"error":{"code":"RATE_LIMITED","message":"Too many requests. Please try again later.","retryAfterSeconds":45}}\n\n',
    );

    const unavailableText = await (await callRoute(streamRoute(unavailable.events), request("POST", "/api/test"))).text();
    expect(unavailableText).toBe(
      'event: token\ndata: {"type":"token","text":"a"}\n\n' +
        'event: error\ndata: {"error":{"code":"UPSTREAM_UNAVAILABLE","message":"A required service is temporarily unavailable. Please try again later.","retryAfterSeconds":30}}\n\n',
    );
  });

  it("a thrown error or an event that breaks the contract is a generic error frame — no message, in the stream or the log", async () => {
    h = await createRouteHarness();
    const logs = captureLogs();
    const thrown = source([
      { type: "token", text: "a" },
      () => {
        throw new Error("postgres://admin:hunter2@db");
      },
    ]);
    const malformed = source([{ type: "token", text: "a" }, { type: "token", text: 42 }]);

    for (const { events, state } of [thrown, malformed]) {
      const text = await (await callRoute(streamRoute(events), request("POST", "/api/test"))).text();
      expect(text).toBe(
        'event: token\ndata: {"type":"token","text":"a"}\n\n' +
          `event: error\ndata: {"error":{"code":"INTERNAL_ERROR","message":"${INTERNAL_ERROR_MESSAGE}"}}\n\n`,
      );
      expect(state.closed).toBe(true);
    }
    expect(logs()).not.toContain("hunter2");
  });

  it("a client that disconnects closes the iterator", async () => {
    h = await createRouteHarness();
    const { state, events } = source([
      { type: "token", text: "a" },
      { type: "token", text: "b" },
      { type: "token", text: "c" },
      { type: "final", answer: "abc" },
    ]);

    const res = await callRoute(streamRoute(events), request("POST", "/api/test"));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(state.closed).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });
});
