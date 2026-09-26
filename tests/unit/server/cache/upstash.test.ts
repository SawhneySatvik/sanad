import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstashRedisCache } from "@/server/cache/upstash";

const CONFIG = { url: "https://fake-upstash.example/", token: "fake-token-do-not-log" };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

// vi.fn()'s inferred signature depends on its first call, which loses the (url, init) shape a
// bare `vi.fn(async () => ...)` needs for `.mock.calls[0]` below — declared explicitly instead.
function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.fn(handler);
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("UpstashRedisCache", () => {
  it("GET sends the documented wire format: POST [\"GET\", key] with a bearer header", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ result: "cached-value" }));
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);

    expect(await cache.get("my-key")).toBe("cached-value");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CONFIG.url);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CONFIG.token}`);
    expect(JSON.parse(init.body as string)).toEqual(["GET", "my-key"]);
  });

  it("a genuine cache miss (Upstash's own null result) is null, not an error", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ result: null }));
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);
    expect(await cache.get("absent")).toBeNull();
  });

  it("SET sends the documented wire format: POST [\"SET\", key, value, \"EX\", ttl]", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ result: "OK" }));
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);

    await cache.set("my-key", "my-value", 120);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual(["SET", "my-key", "my-value", "EX", "120"]);
  });

  it("a timeout — a fetch that never settles and ignores the abort signal — resolves get() to null within the timeout window, never hanging", async () => {
    const fetchImpl = fakeFetch(() => new Promise<Response>(() => {})); // never resolves, never rejects
    const cache = new UpstashRedisCache(CONFIG, fetchImpl, 50);

    const start = Date.now();
    expect(await cache.get("k")).toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("set() is a no-op (never throws, never rejects) on the same kind of timeout", async () => {
    const fetchImpl = fakeFetch(() => new Promise<Response>(() => {}));
    const cache = new UpstashRedisCache(CONFIG, fetchImpl, 50);
    await expect(cache.set("k", "v", 60)).resolves.toBeUndefined();
  });

  it("a network rejection never throws into the caller — get() resolves null", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("ECONNRESET");
    });
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);
    await expect(cache.get("k")).resolves.toBeNull();
  });

  it("a non-2xx HTTP response never throws — get() resolves null", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({}, false, 500));
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);
    await expect(cache.get("k")).resolves.toBeNull();
  });

  it("set() never throws even when the caller awaits it inline with no try/catch of its own", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({}, false, 500));
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);
    await cache.set("k", "v", 60); // would throw the test itself if set() ever rejected
  });

  it("logs metadata only — operation and outcome, never the key, the value, or the bearer token", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ result: "some-secret-looking-value" }));
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);
    await cache.get("a-key-that-must-not-leak");
    await cache.set("a-key-that-must-not-leak", "some-secret-looking-value", 60);

    const logged = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    for (const line of logged) {
      expect(line).not.toContain("a-key-that-must-not-leak");
      expect(line).not.toContain("some-secret-looking-value");
      expect(line).not.toContain(CONFIG.token);
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every((line: string) => JSON.parse(line).event === "cache_op")).toBe(true);
  });

  it("logs an error class on failure, still with no key or value", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("boom");
    });
    const cache = new UpstashRedisCache(CONFIG, fetchImpl);
    await cache.get("some-key");

    const [line] = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const parsed = JSON.parse(line);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorClass).toBe("Error");
    expect(line).not.toContain("some-key");
  });
});
