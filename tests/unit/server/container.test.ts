// The composition root: when each piece is built, the per-request rate-limited LLM client (principal
// and client IP charged per LLM call), configStatus, the production wiring, the test-install guard,
// and the default "no user" auth hook.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "@tests/support/db";
import { MemoryKeyValueCache } from "@/server/cache/memory";
import { NamespacedCache } from "@/server/cache/namespaced";
import { ConfigError } from "@/server/core/env";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { geminiModelId } from "@/server/llm/providers";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { PostgresStorageAdapter } from "@/server/storage/postgres-adapter";
import type { StorageAdapter } from "@/server/storage/types";
import {
  createContainer,
  getContainer,
  productionContainerOptions,
  setContainerForTests,
  type ContainerOptions,
} from "@/server/container";
import type { Principal } from "@/server/core/types";

const GUEST_A_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const guestA: Principal = { type: "guest", guestSessionId: GUEST_A_ID };
const guestB: Principal = { type: "guest", guestSessionId: "0b0b0b0b-0000-4000-8000-00000000000b" };
const Answer = z.object({ answer: z.string() });
const call = { systemPrompt: "s", userPrompt: "u", schema: Answer };
// Every call in a test lands in one fixed-minute window.
const FIXED_CLOCK = { now: () => new Date("2026-09-23T10:00:30.000Z") };

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  setContainerForTests(undefined);
  await t.close();
});

function options(overrides: Partial<ContainerOptions> = {}): ContainerOptions {
  const primary = new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: { answer: "yes" } } });
  const secondary = new FakeLlmClient({ modelUsed: "fake-secondary", defaultResponse: { data: { answer: "no" } } });
  return {
    db: t.db,
    storage: () => ({}) as StorageAdapter,
    llm: () => ({ primary, secondary }),
    localStorageSigningSecret: () => "container-test-signing-secret-0123456789",
    primaryModelId: "fake-model",
    ...overrides,
  };
}

// Per-minute principal charges only; the daily counters share the table under a `day:` prefix.
async function principalCharges(): Promise<number> {
  const result = await t.client.query<{ n: number }>(
    "SELECT coalesce(sum(request_count), 0)::int AS n FROM rate_limit_buckets WHERE principal_key NOT LIKE 'day:%'",
  );
  return result.rows[0].n;
}

async function complete(llm: { complete: (input: typeof call) => Promise<unknown> }): Promise<string> {
  return llm.complete(call).then(
    () => "ok",
    (error: { code?: string }) => error.code ?? "threw",
  );
}

describe("createContainer", () => {
  it("builds nothing at creation; providers when a request's deps are built, storage on first touch — each once", () => {
    const storage = vi.fn(() => ({}) as StorageAdapter);
    const llm = vi.fn(options().llm);
    const container = createContainer(options({ storage, llm }));
    expect([storage.mock.calls.length, llm.mock.calls.length]).toEqual([0, 0]);

    const deps = container.forRequest(guestA);
    expect([storage.mock.calls.length, llm.mock.calls.length]).toEqual([0, 1]);

    expect(deps.storage).toBe(deps.storage);
    expect(deps.llm).toBe(deps.llm);
    const other = container.forRequest(guestB);
    expect(other.llm).not.toBe(deps.llm);
    expect([storage.mock.calls.length, llm.mock.calls.length]).toEqual([1, 1]);
    expect(deps.modelId).toBe("fake-model");
  });

  it("a missing provider key fails forRequest itself — before any service could run", () => {
    const container = createContainer(
      options({
        llm: () => {
          throw new ConfigError("NVIDIA_API_KEY");
        },
      }),
    );

    expect(() => container.forRequest(guestA)).toThrow(ConfigError);
  });

  it("usesLlm = false builds no providers, and deps.llm then throws rather than building them late", () => {
    const llm = vi.fn(options().llm);
    const container = createContainer(options({ llm }));

    const deps = container.forRequest(guestA, false);

    expect(() => deps.llm).toThrow(/usesLlm: false/);
    expect(llm).not.toHaveBeenCalled();
  });

  it("each request's llm charges its own principal once per LLM call, and a request that makes none is never charged", async () => {
    const container = createContainer(options());

    const deps = container.forRequest(guestA);
    await deps.llm.complete(call);
    await deps.llm.complete(call);
    void container.forRequest(guestB).llm;

    const rows = await t.client.query<{ principal_key: string; request_count: number }>(
      "SELECT principal_key, request_count FROM rate_limit_buckets ORDER BY principal_key",
    );
    expect(rows.rows).toEqual([
      { principal_key: `day:guest:${GUEST_A_ID}`, request_count: 2 },
      { principal_key: `guest:${GUEST_A_ID}`, request_count: 2 },
    ]);
  });

  it("charges the request's client IP per LLM call: a fresh principal from the same IP is refused before any provider", async () => {
    const primary = new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: { answer: "yes" } } });
    const container = createContainer(
      options({ llm: () => ({ primary, secondary: primary }), rateLimits: { ipLlmPerMinute: 1, clock: FIXED_CLOCK } }),
    );

    expect(await complete(container.forRequest(guestA, true, "203.0.113.9").llm)).toBe("ok");
    expect(await complete(container.forRequest(guestB, true, "203.0.113.9").llm)).toBe("RATE_LIMITED");
    // Positive control: another IP has its own bucket.
    expect(await complete(container.forRequest(guestB, true, "198.51.100.1").llm)).toBe("ok");
    expect(primary.callCount).toBe(2);
  });

  it("a request built without a client IP shares the one UNKNOWN_CLIENT_IP bucket — never an unlimited one", async () => {
    const container = createContainer(options({ rateLimits: { ipLlmPerMinute: 1, clock: FIXED_CLOCK } }));

    expect(await complete(container.forRequest(guestA).llm)).toBe("ok");
    expect(await complete(container.forRequest(guestB).llm)).toBe("RATE_LIMITED");
  });

  it("the daily overrides reach the per-call tiers", async () => {
    const principalDaily = createContainer(options({ rateLimits: { principalPerDay: 1, clock: FIXED_CLOCK } }));
    expect(await complete(principalDaily.forRequest(guestA, true, "203.0.113.10").llm)).toBe("ok");
    expect(await complete(principalDaily.forRequest(guestA, true, "203.0.113.11").llm)).toBe("RATE_LIMITED");

    const ipDaily = createContainer(options({ rateLimits: { ipLlmPerDay: 1, clock: FIXED_CLOCK } }));
    expect(await complete(ipDaily.forRequest(guestA, true, "203.0.113.12").llm)).toBe("ok");
    expect(await complete(ipDaily.forRequest(guestB, true, "203.0.113.12").llm)).toBe("RATE_LIMITED");
  });

  it("the principal limit rejects the call over it before any provider is reached", async () => {
    const primary = new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: { answer: "yes" } } });
    const container = createContainer(
      // Fixed clock: both calls must land in one fixed-minute window.
      options({
        llm: () => ({ primary, secondary: primary }),
        rateLimits: { principalPerMinute: 1, clock: { now: () => new Date("2026-09-23T10:00:30.000Z") } },
      }),
    );
    const deps = container.forRequest(guestA);

    await deps.llm.complete(call);
    await expect(deps.llm.complete(call)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(primary.callCount).toBe(1);
    expect(await principalCharges()).toBe(2);
  });

  it("refuses a blank primary model id (the cache key)", () => {
    expect(() => createContainer(options({ primaryModelId: "  " }))).toThrow(/primaryModelId must not be blank/);
  });

  it("configStatus builds each piece and answers with whether it built", () => {
    const broken = createContainer(
      options({
        storage: () => {
          throw new Error("signingSecret too short");
        },
        llm: () => {
          throw new ConfigError("GEMINI_API_KEY");
        },
      }),
    );

    expect(createContainer(options()).configStatus()).toEqual({ llm: true, storage: true });
    expect(broken.configStatus()).toEqual({ llm: false, storage: false });
  });

  it("has no user unless an auth hook is given — whatever the request carries", async () => {
    const container = createContainer(options());
    const req = new Request("http://localhost/", { headers: { "x-user-id": "a1a1a1a1-0000-4000-8000-0000000000a1" } });

    expect(await container.authenticateUser(req)).toBeNull();
  });

  it("no cache thunk: deps.cache is undefined — never silently defaulted to a memory cache", () => {
    const container = createContainer(options());
    expect(container.forRequest(guestA).cache).toBeUndefined();
  });

  it("a cache thunk is built once per container, not once per request — an L1 tier does nothing otherwise", () => {
    const cache = vi.fn(() => new MemoryKeyValueCache());
    const container = createContainer(options({ cache }));

    const first = container.forRequest(guestA).cache;
    const second = container.forRequest(guestB).cache;

    expect(cache).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

describe("productionContainerOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keys the cache on geminiModelId(), the resolver createGeminiClient() uses", () => {
    vi.stubEnv("GEMINI_MODEL", "gemini-test-model");

    expect(productionContainerOptions(t.db).primaryModelId).toBe(geminiModelId());
    expect(geminiModelId()).toBe("gemini-test-model");
  });

  it("storage is unbuildable with a signing secret under 32 bytes, buildable with one that is long enough", () => {
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "short");
    expect(createContainer(productionContainerOptions(t.db)).configStatus().storage).toBe(false);

    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "x".repeat(32));
    expect(createContainer(productionContainerOptions(t.db)).configStatus().storage).toBe(true);
  });

  it("picks LocalFsStorageAdapter by default (unset STORAGE_BACKEND, no VERCEL) — the dev/e2e-server default", () => {
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "x".repeat(32));
    const container = createContainer(productionContainerOptions(t.db));
    expect(container.forRequest(guestA, false).storage).toBeInstanceOf(LocalFsStorageAdapter);
  });

  it("STORAGE_BACKEND=postgres picks PostgresStorageAdapter even off Vercel", () => {
    vi.stubEnv("STORAGE_BACKEND", "postgres");
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "x".repeat(32));
    const container = createContainer(productionContainerOptions(t.db));
    expect(container.forRequest(guestA, false).storage).toBeInstanceOf(PostgresStorageAdapter);
  });

  it("VERCEL forces PostgresStorageAdapter regardless of STORAGE_BACKEND — each function instance has its own ephemeral disk", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("STORAGE_BACKEND", "local");
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "x".repeat(32));
    const container = createContainer(productionContainerOptions(t.db));
    expect(container.forRequest(guestA, false).storage).toBeInstanceOf(PostgresStorageAdapter);
  });

  it("an unrecognized STORAGE_BACKEND value fails config status rather than silently falling back to LocalFs", () => {
    vi.stubEnv("STORAGE_BACKEND", "postgress");
    vi.stubEnv("LOCAL_STORAGE_SIGNING_SECRET", "x".repeat(32));
    expect(createContainer(productionContainerOptions(t.db)).configStatus().storage).toBe(false);
  });

  it("the providers are unbuildable while any provider key is missing", () => {
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("NVIDIA_API_KEY", "n");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(createContainer(productionContainerOptions(t.db)).configStatus().llm).toBe(false);

    vi.stubEnv("OPENROUTER_API_KEY", "o");
    expect(createContainer(productionContainerOptions(t.db)).configStatus().llm).toBe(true);
  });

  it("refuses a cache model id that is not the primary client's model, when it first builds the providers", () => {
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("NVIDIA_API_KEY", "n");
    vi.stubEnv("OPENROUTER_API_KEY", "o");
    vi.stubEnv("GEMINI_MODEL", "gemini-test-model");

    const mismatched = createContainer({ ...productionContainerOptions(t.db), primaryModelId: "gemini-other-model" });
    expect(() => mismatched.forRequest(guestA)).toThrow(/must equal the primary LLM client's model id \("gemini-test-model"\)/);
    expect(mismatched.configStatus().llm).toBe(false);

    const real = createContainer(productionContainerOptions(t.db));
    expect(real.forRequest(guestA).modelId).toBe("gemini-test-model");
    expect(real.configStatus().llm).toBe(true);
  });

  it("builds a memory-only cache with no Upstash env var set", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    const container = createContainer(productionContainerOptions(t.db));
    // usesLlm: false — this test cares about the cache thunk, not the LLM providers, which would
    // otherwise demand a GEMINI_API_KEY this suite never stubs.
    expect(container.forRequest(guestA, false).cache).toBeInstanceOf(MemoryKeyValueCache);
  });

  it("builds a layered, namespaced cache once a complete Upstash pair is set — without ever calling it", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    const container = createContainer(productionContainerOptions(t.db));
    // instanceof only — this suite never calls .get()/.set(), so it can never reach the network
    // even if a real Upstash instance happened to be reachable at this URL.
    expect(container.forRequest(guestA, false).cache).toBeInstanceOf(NamespacedCache);
  });
});

describe("getContainer", () => {
  it("under test, refuses to fall back to the on-disk production container", () => {
    expect(() => getContainer()).toThrow(/No container installed/);
  });

  it("returns the installed container", () => {
    const container = createContainer(options());
    setContainerForTests(container);

    expect(getContainer()).toBe(container);
  });

  it("importing the module reads no env var and builds nothing", async () => {
    for (const name of ["GEMINI_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "LOCAL_STORAGE_SIGNING_SECRET"]) {
      vi.stubEnv(name, "");
    }
    vi.resetModules();

    await expect(import("@/server/container")).resolves.toHaveProperty("getContainer");
    vi.unstubAllEnvs();
  });
});
