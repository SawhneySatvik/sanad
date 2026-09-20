// GET /api/health — whether the LLM providers and the storage adapter can be built from the
// configuration, by building them, never a value, no LLM call. "ok" must never sit next to an
// upload that would fail on configuration.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as healthRoute from "@/app/api/health/route";
import * as projectsRoute from "@/app/api/projects/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { createContainer, productionContainerOptions, setContainerForTests } from "@/server/container";
import { ConfigError } from "@/server/core/env";
import { canAccess } from "@/server/data/access";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { HealthOutput } from "@/shared/contracts/health";
import { callRoute, createRouteHarness, FIXED_CLOCK, guestCookie, mintedCookie, request, type RouteHarness } from "./harness";

const SECRETS: Record<string, string> = {
  GEMINI_API_KEY: "gemini-key-DO-NOT-ECHO-1111",
  NVIDIA_API_KEY: "nvidia-key-DO-NOT-ECHO-2222",
  OPENROUTER_API_KEY: "openrouter-key-DO-NOT-ECHO-3333",
  LOCAL_STORAGE_SIGNING_SECRET: "storage-secret-DO-NOT-ECHO-4444444444444444",
};

let h: RouteHarness;
let storageRoot: string;
let productionStorage: LocalFsStorageAdapter | undefined;
beforeEach(async () => {
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  storageRoot = await mkdtemp(path.join(tmpdir(), "health-test-"));
  productionStorage = undefined;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h.close();
  await productionStorage?.lastSweep;
  await rm(storageRoot, { recursive: true, force: true });
});

function getHealth(headers?: Record<string, string>) {
  return callRoute(healthRoute.GET, request("GET", "/api/health", { headers }));
}

async function health() {
  return HealthOutput.parse(await (await getHealth()).json());
}

// The production container's wiring, over this test's in-memory database. Its storage is the
// production adapter, built from the same env secret and access check, but on this test's own root:
// POST /api/uploads writes an upload record and may start a sweep, and neither may touch the
// developer's store. The relay is never used.
function installProductionWiring(): void {
  const production = productionContainerOptions(h.t.db);
  setContainerForTests(
    createContainer({
      ...production,
      storage: () =>
        (productionStorage = new LocalFsStorageAdapter({
          accessCheck: canAccess,
          signingSecret: production.localStorageSigningSecret(),
          rootDir: storageRoot,
        })),
      rateLimits: { ipPerMinute: 1000 },
    }),
  );
}

function createUploadTarget() {
  return callRoute(
    uploadsRoute.POST,
    request("POST", "/api/uploads", {
      cookie: guestCookie().cookie,
      json: { filename: "lease.txt", mimeType: "text/plain", sizeBytes: 10 },
    }),
  );
}

describe("GET /api/health", () => {
  it("is ok when the providers and storage build — and says nothing about any value", async () => {
    h = await createRouteHarness();
    installProductionWiring();

    const res = await getHealth();

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(HealthOutput.parse(JSON.parse(text))).toEqual({ status: "ok", config: { llm: true, storage: true } });
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
    expect((await createUploadTarget()).status).toBe(200);
  });

  it("a signing secret under 32 bytes is degraded storage — the same configuration on which uploads 500", async () => {
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "too-short");
    h = await createRouteHarness();
    installProductionWiring();

    expect(await health()).toEqual({ status: "degraded", config: { llm: true, storage: false } });
    expect((await createUploadTarget()).status).toBe(500);
  });

  it("a missing provider key is degraded llm", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    h = await createRouteHarness();
    installProductionWiring();

    expect(await health()).toEqual({ status: "degraded", config: { llm: false, storage: true } });
  });

  it("reflects the installed container's own providers (a provider thunk that throws)", async () => {
    h = await createRouteHarness({
      providers: () => {
        throw new ConfigError("NVIDIA_API_KEY");
      },
    });

    expect(await health()).toEqual({ status: "degraded", config: { llm: false, storage: true } });
    expect(h.primary.callCount + h.secondary.callCount).toBe(0);
  });

  it("resolves no identity: no guest cookie, no auth-hook call, no IP-tier row — and so is never IP-limited", async () => {
    h = await createRouteHarness({ rateLimits: { ipPerMinute: 2, clock: FIXED_CLOCK } });
    const ip = { "x-forwarded-for": "198.51.100.7" };

    const responses = [await getHealth(ip), await getHealth(ip), await getHealth(ip)];

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    for (const res of responses) expect(res.headers.getSetCookie()).toEqual([]);
    expect(h.authCalls()).toBe(0);
    const buckets = await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM ip_rate_limit_buckets");
    expect(buckets.rows[0].n).toBe(0);
  });

  it("an identity-resolving route on the same IP still is IP-limited and mints a cookie (positive control)", async () => {
    h = await createRouteHarness({ rateLimits: { ipPerMinute: 2, clock: FIXED_CLOCK } });
    const ip = { "x-forwarded-for": "198.51.100.7" };
    const list = () => callRoute(projectsRoute.GET, request("GET", "/api/projects", { headers: ip }));

    const responses = [await list(), await list(), await list()];

    expect(responses.map((res) => res.status)).toEqual([200, 200, 429]);
    expect(mintedCookie(responses[0])).not.toBeNull();
    expect(h.authCalls()).toBeGreaterThan(0);
  });
});
