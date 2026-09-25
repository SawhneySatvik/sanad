// The security headers: next.config.ts applies them to every path, and route() sets them on every
// response it builds — success, error, cross-site refusal, event stream and the identity-less
// health route — so a route handler called directly (as here) carries them too.

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import nextConfig from "../../../../next.config";
import * as healthRoute from "@/app/api/health/route";
import { AppError } from "@/server/core/errors";
import { route } from "@/server/http/handler";
import { securityHeaders } from "@/server/http/security-headers";
import { callRoute, createRouteHarness, request, type RouteHarness } from "@tests/integration/routes/harness";

const CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'";

// The headers every environment carries, whatever NODE_ENV is.
const BASE = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

// vitest's own NODE_ENV, per container.ts's own "no accidental production container" check —
// pinned here too, rather than assumed, since securityHeaders() branches on it.
const EXPECTED_TEST = { ...BASE, "content-security-policy": CSP };

let h: RouteHarness | undefined;
let spies: MockInstance[] = [];
afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  await h?.close();
  h = undefined;
});

function silenceLogs(): void {
  spies = (["error", "warn"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
}

function securityHeadersOf(res: Response): Record<string, string | null> {
  return Object.fromEntries(Object.keys(EXPECTED_TEST).map((name) => [name, res.headers.get(name)]));
}

describe("securityHeaders()", () => {
  it("under NODE_ENV=test: the base six, no HSTS, no unsafe-eval", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(securityHeaders()).toEqual(EXPECTED_TEST);
  });

  it("under NODE_ENV=production: adds HSTS without preload, still no unsafe-eval", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = securityHeaders();
    vi.unstubAllEnvs();

    expect(headers).toEqual({ ...EXPECTED_TEST, "strict-transport-security": "max-age=63072000; includeSubDomains" });
    expect(headers["strict-transport-security"]).not.toContain("preload");
    expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
  });

  it("under NODE_ENV=development: adds unsafe-eval to script-src, still no HSTS", () => {
    vi.stubEnv("NODE_ENV", "development");
    const headers = securityHeaders();
    vi.unstubAllEnvs();

    expect(headers["strict-transport-security"]).toBeUndefined();
    expect(headers["content-security-policy"]).toBe(CSP.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'"));
  });
});

describe("next.config.ts", () => {
  it("applies securityHeaders() to every path and turns off X-Powered-By", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(await nextConfig.headers?.()).toEqual([
      { source: "/:path*", headers: Object.entries(EXPECTED_TEST).map(([key, value]) => ({ key, value })) },
    ]);
  });
});

describe("every route() response carries them", () => {
  const Echo = z.object({ value: z.string() });

  it("a JSON 200, an AppError, a generic 500 and a cross-site 403", async () => {
    h = await createRouteHarness();
    silenceLogs();
    const ok = route({ usesLlm: false, response: Echo, run: async () => ({ value: "ok" }) });
    const rejects = route({
      usesLlm: false,
      response: Echo,
      run: async () => {
        throw new AppError("NOT_FOUND", "x");
      },
    });
    const crashes = route({
      usesLlm: false,
      response: Echo,
      run: async () => {
        throw new Error("boom");
      },
    });

    const responses = [
      await callRoute(ok, request("GET", "/api/test")),
      await callRoute(rejects, request("GET", "/api/test")),
      await callRoute(crashes, request("GET", "/api/test")),
      await callRoute(ok, request("POST", "/api/test", { headers: { "sec-fetch-site": "cross-site" } })),
    ];

    expect(responses.map((res) => res.status)).toEqual([200, 404, 500, 403]);
    for (const res of responses) expect(securityHeadersOf(res)).toEqual(EXPECTED_TEST);
  });

  it("an event stream", async () => {
    h = await createRouteHarness();
    const stream = route({
      usesLlm: false,
      events: z.object({ type: z.literal("final") }),
      run: async function* () {
        yield { type: "final" as const };
      },
    });

    const res = await callRoute(stream, request("GET", "/api/test"));

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(securityHeadersOf(res)).toEqual(EXPECTED_TEST);
    await res.text();
  });

  it("GET /api/health, which resolves no identity", async () => {
    h = await createRouteHarness();

    const res = await callRoute(healthRoute.GET, request("GET", "/api/health"));

    expect(res.status).toBe(200);
    expect(securityHeadersOf(res)).toEqual(EXPECTED_TEST);
  });
});
