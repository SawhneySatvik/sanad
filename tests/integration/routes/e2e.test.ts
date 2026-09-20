// GET /api/e2e/throw and GET /api/e2e/ping — the two dev-only e2e-harness routes, driven through
// the real route() wrapper in both modes: refused (404) whenever SABOOT_E2E isn't "1", and doing
// their one job (throw / 200) once it is.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as pingRoute from "@/app/api/e2e/ping/route";
import * as throwRoute from "@/app/api/e2e/throw/route";
import { INTERNAL_ERROR_MESSAGE } from "@/server/http/errors";
import { HealthOutput } from "@/shared/contracts/health";
import { callRoute, createRouteHarness, request, type RouteHarness } from "./harness";

let h: RouteHarness;

afterEach(async () => {
  vi.unstubAllEnvs();
  await h.close();
});

function getThrow() {
  return callRoute(throwRoute.GET, request("GET", "/api/e2e/throw"));
}

function getPing() {
  return callRoute(pingRoute.GET, request("GET", "/api/e2e/ping"));
}

describe("GET /api/e2e/throw", () => {
  it("404s when SABOOT_E2E isn't set", async () => {
    vi.stubEnv("SABOOT_E2E", "");
    h = await createRouteHarness();

    const res = await getThrow();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("500s with a deliberate failure when SABOOT_E2E=1", async () => {
    vi.stubEnv("SABOOT_E2E", "1");
    h = await createRouteHarness();

    const res = await getThrow();

    expect(res.status).toBe(500);
    const body = await res.json();
    // The safe, generic body every uncaught (non-AppError) throw maps to — never the real
    // Error#message, which would leak "SABOOT_E2E forced-throw route: …" to the client.
    expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: INTERNAL_ERROR_MESSAGE } });
    expect(JSON.stringify(body)).not.toContain("forced-throw");
  });

  it("any value but the literal \"1\" behaves exactly like unset", async () => {
    h = await createRouteHarness();
    for (const value of ["true", "0", "yes"]) {
      vi.stubEnv("SABOOT_E2E", value);
      const res = await getThrow();
      expect(res.status, value).toBe(404);
    }
  });
});

describe("GET /api/e2e/ping", () => {
  it("404s when SABOOT_E2E isn't set", async () => {
    vi.stubEnv("SABOOT_E2E", "");
    h = await createRouteHarness();

    const res = await getPing();

    expect(res.status).toBe(404);
  });

  it("200s when SABOOT_E2E=1", async () => {
    vi.stubEnv("SABOOT_E2E", "1");
    h = await createRouteHarness();

    const res = await getPing();

    expect(res.status).toBe(200);
    const body = await res.json();
    // HealthOutput.parse() pins the response's shape against the shared contract, independent of
    // ping()'s own object literal; the literal true/true/"ok" values are a regression pin on what
    // ping() always returns for a healthy harness, not an independently-specified value.
    expect(HealthOutput.parse(body)).toEqual({ status: "ok", config: { llm: true, storage: true } });
  });
});
