// The route wrapper itself, with test-only routes built from route() — the plumbing every real
// route shares (IP tier, validation, contract serialization, error mapping). Runs over a real
// container (in-memory PGlite, real limiter), so the IP tier is the production one.

import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as healthRoute from "@/app/api/health/route";
import { ConfigError } from "@/server/core/env";
import { AppError, notFound } from "@/server/core/errors";
import { IdParams, IsoDateTime } from "@/shared/contracts/common";
import {
  callRoute,
  createRouteHarness,
  FIXED_CLOCK,
  guestCookie,
  mintedCookie,
  request,
  type RouteHarness,
} from "@tests/integration/routes/harness";
import { CORRELATION_ID_HEADER, INTERNAL_ERROR_MESSAGE } from "@/server/http/errors";
import { route } from "@/server/http/handler";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";

const Echo = z.object({ value: z.string() });

let h: RouteHarness | undefined;
let spies: MockInstance[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const spy of spies) spy.mockRestore();
  spies = [];
  await h?.close();
  h = undefined;
});

function captureLogs(): () => string {
  spies = (["error", "warn", "log"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
  return () => spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" "))).join("\n");
}

describe("the IP tier", () => {
  it("answers the (limit+1)th request from one IP with 429 + Retry-After to the window's end, before run", async () => {
    // Behind one declared reverse proxy, so X-Forwarded-For names the client.
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const clock = { now: () => new Date("2026-09-23T10:00:45.000Z") };
    h = await createRouteHarness({ rateLimits: { ipPerMinute: 2, clock } });
    let runs = 0;
    const handler = route({ response: Echo, run: async () => ({ value: `run ${++runs}` }) });
    const from = (ip: string) => request("GET", "/api/test", { headers: { "x-forwarded-for": ip } });

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await callRoute(handler, from("203.0.113.9"))).status);
    const limited = await callRoute(handler, from("203.0.113.9"));

    expect(statuses).toEqual([200, 200, 429]);
    expect(limited.headers.get("retry-after")).toBe("15");
    expect(await limited.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later.", retryAfterSeconds: 15 },
    });
    expect(runs).toBe(2);
    // The same client in another spelling shares the bucket; another client has its own.
    expect((await callRoute(handler, from("::ffff:203.0.113.9"))).status).toBe(429);
    expect((await callRoute(handler, from("198.51.100.1"))).status).toBe(200);
  });

  it("requests with no usable client IP share one conservative bucket", async () => {
    h = await createRouteHarness({ rateLimits: { ipPerMinute: 2, clock: FIXED_CLOCK } });
    const handler = route({ response: Echo, run: async () => ({ value: "ok" }) });

    const statuses = [
      (await callRoute(handler, request("GET", "/api/test"))).status,
      (await callRoute(handler, request("GET", "/api/test", { headers: { "x-forwarded-for": "garbage" } }))).status,
      (await callRoute(handler, request("GET", "/api/test"))).status,
    ];

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("charges each LLM call to the request's own client IP: fresh guest cookies from one IP share its bucket, another IP has its own", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: { answer: "x" } } }),
      rateLimits: { ipLlmPerMinute: 1, clock: FIXED_CLOCK },
    });
    const Answer = z.object({ answer: z.string() });
    const handler = route({
      response: Echo,
      run: async ({ deps }) => ({ value: (await deps.llm.complete({ systemPrompt: "s", userPrompt: "u", schema: Answer })).data.answer }),
    });
    const from = (ip: string) => request("GET", "/api/test", { cookie: guestCookie().cookie, headers: { "x-forwarded-for": ip } });

    const statuses = [
      (await callRoute(handler, from("203.0.113.9"))).status,
      (await callRoute(handler, from("203.0.113.9"))).status,
      (await callRoute(handler, from("198.51.100.1"))).status,
    ];

    expect(statuses).toEqual([200, 429, 200]);
  });
});

describe("validation", () => {
  it("an invalid path param is the same 404, byte for byte, as a service's NOT_FOUND", async () => {
    h = await createRouteHarness();
    const handler = route({
      params: IdParams,
      response: Echo,
      run: async () => {
        throw notFound();
      },
    });

    const invalid = await callRoute(handler, request("GET", "/api/test/x"), { id: "x" });
    const missing = await callRoute(handler, request("GET", "/api/test/x"), { id: "0a0a0a0a-0000-4000-8000-00000000000a" });

    expect([invalid.status, await invalid.text()]).toEqual([missing.status, await missing.text()]);
    expect(invalid.status).toBe(404);
  });

  it("an invalid body or query is a 400 that echoes nothing", async () => {
    h = await createRouteHarness();
    const body = route({ body: z.strictObject({ n: z.number() }), response: Echo, run: async () => ({ value: "ok" }) });
    const query = route({ query: z.strictObject({ q: z.string() }), response: Echo, run: async () => ({ value: "ok" }) });

    const badBody = await callRoute(body, request("POST", "/api/test", { json: { n: "ECHO-ME" } }));
    const badQuery = await callRoute(query, request("GET", "/api/test?q=a&ECHO-ME=1"));

    for (const res of [badBody, badQuery]) {
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: { code: "VALIDATION_FAILED", message: "The request could not be validated." },
      });
    }
  });

  it("a JSON body over maxBodyBytes is refused, declared or streamed", async () => {
    h = await createRouteHarness();
    let runs = 0;
    const handler = route({
      body: z.object({ s: z.string() }),
      maxBodyBytes: 32,
      response: Echo,
      run: async () => ({ value: `run ${++runs}` }),
    });
    const big = { s: "x".repeat(100) };

    const streamed = await callRoute(handler, request("POST", "/api/test", { json: big }));
    const declared = await callRoute(
      handler,
      request("POST", "/api/test", { json: { s: "x" }, headers: { "content-length": "1000" } }),
    );
    const fits = await callRoute(handler, request("POST", "/api/test", { json: { s: "x" } }));

    expect([streamed.status, declared.status, fits.status]).toEqual([400, 400, 200]);
    expect(runs).toBe(1);
  });
});

describe("JSON bodies need Content-Type: application/json", () => {
  it("refuses text/plain (a cross-site simple request) and a missing type with a 400; accepts a charset parameter", async () => {
    h = await createRouteHarness();
    let runs = 0;
    const handler = route({ body: z.object({ s: z.string() }), response: Echo, run: async () => ({ value: `run ${++runs}` }) });
    const send = (contentType: string | null) =>
      callRoute(
        handler,
        new Request("http://localhost/api/test", {
          method: "POST",
          headers: contentType ? { "content-type": contentType } : {},
          body: JSON.stringify({ s: "x" }),
        }),
      );

    const statuses = [
      (await send("text/plain")).status,
      (await send("application/x-www-form-urlencoded")).status,
      (await send(null)).status,
      (await send("Application/JSON; charset=utf-8")).status,
    ];

    expect(statuses).toEqual([400, 400, 400, 200]);
    expect(runs).toBe(1);
  });
});

describe("usesLlm", () => {
  const failingProviders = () => {
    throw new ConfigError("NVIDIA_API_KEY");
  };

  it("by default the providers are built before run: a missing key is a 500 and run never starts", async () => {
    h = await createRouteHarness({ providers: failingProviders });
    captureLogs();
    let runs = 0;
    const handler = route({ response: Echo, run: async () => ({ value: `run ${++runs}` }) });

    const res = await callRoute(handler, request("GET", "/api/test"));

    expect(res.status).toBe(500);
    expect(runs).toBe(0);
  });

  it("usesLlm: false needs no provider key — and a service that reads deps.llm anyway is a loud 500", async () => {
    h = await createRouteHarness({ providers: failingProviders });
    captureLogs();
    const plain = route({ usesLlm: false, response: Echo, run: async () => ({ value: "ok" }) });
    const misdeclared = route({ usesLlm: false, response: Echo, run: async ({ deps }) => ({ value: String(deps.llm) }) });

    expect((await callRoute(plain, request("GET", "/api/test"))).status).toBe(200);
    expect((await callRoute(misdeclared, request("GET", "/api/test"))).status).toBe(500);
  });
});

describe("responses", () => {
  it("pass through the response contract: undeclared fields are stripped, dates become ISO strings", async () => {
    h = await createRouteHarness();
    const handler = route({
      response: z.object({ value: z.string(), at: IsoDateTime }),
      run: async () => ({ value: "ok", at: new Date("2026-09-23T10:00:00.000Z"), ownerGuestSessionId: "secret" }),
    });

    const res = await callRoute(handler, request("GET", "/api/test"));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ value: "ok", at: "2026-09-23T10:00:00.000Z" });
  });

  it("a result that breaks its contract is a generic 500 — no validation detail in the body or the log", async () => {
    h = await createRouteHarness();
    const logs = captureLogs();
    const handler = route({ response: Echo, run: async () => ({ value: 42, leaked: "ECHO-ME" }) });

    const res = await callRoute(handler, request("GET", "/api/test"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: INTERNAL_ERROR_MESSAGE } });
    expect(logs()).not.toMatch(/ECHO-ME|expected string/i);
    expect(logs()).toContain('"errorType":"ZodError"');
  });

  it("every error response carries a correlation id, no-store, the minted cookie, and Retry-After when the error has one", async () => {
    h = await createRouteHarness();
    captureLogs();
    const handler = route({
      response: Echo,
      run: async () => {
        throw new AppError("RATE_LIMITED", "internal detail", { retryAfterSeconds: 7.2 });
      },
    });

    const res = await callRoute(handler, request("GET", "/api/test"));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    expect(mintedCookie(res)).not.toBeNull();
  });

  it("a request that already has a session gets no new cookie", async () => {
    h = await createRouteHarness();
    const handler = route({ response: Echo, run: async ({ principal }) => ({ value: principal.type }) });

    const res = await callRoute(handler, request("GET", "/api/test", { cookie: guestCookie().cookie }));

    expect(await res.json()).toEqual({ value: "guest" });
    expect(mintedCookie(res)).toBeNull();
  });
});

describe("Next.js route-handler types", () => {
  // Mirrors the RouteHandlerConfig Next 16 generates for `next build`'s type check: every exported
  // method must accept (NextRequest, { params: Promise<the route's params> }).
  type NextRouteHandler<Params> = (
    request: NextRequest,
    context: { params: Promise<Params> },
  ) => Promise<Response | void> | Response | void;

  it("a route() handler is assignable to Next's handler type, with and without params", () => {
    const withParams: NextRouteHandler<{ id: string }> = documentRoute.GET;
    const withoutParams: NextRouteHandler<Record<string, never>> = healthRoute.GET;
    expect([withParams, withoutParams]).toEqual([documentRoute.GET, healthRoute.GET]);
  });
});
