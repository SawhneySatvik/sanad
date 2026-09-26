import { afterEach, describe, expect, it, vi } from "vitest";
import { createCacheFromEnv } from "@/server/cache";
import { LayeredCache } from "@/server/cache/layered";
import { MemoryKeyValueCache } from "@/server/cache/memory";
import { NamespacedCache } from "@/server/cache/namespaced";

// This suite only ever checks what createCacheFromEnv() built (via instanceof), never calls
// .get()/.set() on it — a real Redis instance could be reachable through real env vars in some
// environment, and this suite must stay hermetic (fake fetch only) regardless of that.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createCacheFromEnv", () => {
  it("no Upstash config either name pair: memory-only", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    expect(createCacheFromEnv()).toBeInstanceOf(MemoryKeyValueCache);
  });

  it("UPSTASH_REDIS_REST_URL/TOKEN both set: layered and namespaced", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    const cache = createCacheFromEnv();
    expect(cache).toBeInstanceOf(NamespacedCache);
  });

  it("KV_REST_API_URL/TOKEN both set (Vercel's own integration names): also layered and namespaced", () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "tok");
    expect(createCacheFromEnv()).toBeInstanceOf(NamespacedCache);
  });

  it("a URL from one name pair and a token from the other is not a complete pair: memory-only", () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    expect(createCacheFromEnv()).toBeInstanceOf(MemoryKeyValueCache);
  });

  it("SABOOT_E2E=1 forces memory-only even with a complete Upstash pair — e2e's fake answers must never reach the real shared cache", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok");
    vi.stubEnv("SABOOT_E2E", "1");
    expect(createCacheFromEnv()).toBeInstanceOf(MemoryKeyValueCache);
  });
});

describe("NamespacedCache", () => {
  it("prefixes every key before delegating, on both get and set", async () => {
    const inner = new MemoryKeyValueCache();
    const cache = new NamespacedCache(inner, "local");

    await cache.set("q", "v", 60);
    expect(await inner.get("local:q")).toBe("v");
    expect(await inner.get("q")).toBeNull();
    expect(await cache.get("q")).toBe("v");
  });

  it("two namespaces never see each other's writes, even sharing the same inner cache", async () => {
    const inner = new MemoryKeyValueCache();
    const prod = new NamespacedCache(inner, "production");
    const local = new NamespacedCache(inner, "local");

    await prod.set("q", "prod-answer", 60);
    expect(await local.get("q")).toBeNull();
  });
});

describe("LayeredCache + NamespacedCache composed, the way createCacheFromEnv wires them", () => {
  it("still isolates namespaces end to end", async () => {
    const l2 = new MemoryKeyValueCache();
    const prod = new NamespacedCache(new LayeredCache(new MemoryKeyValueCache(), l2), "production");
    const local = new NamespacedCache(new LayeredCache(new MemoryKeyValueCache(), l2), "local");

    await prod.set("q", "prod-answer", 60);
    expect(await local.get("q")).toBeNull();
    expect(await prod.get("q")).toBe("prod-answer");
  });
});
