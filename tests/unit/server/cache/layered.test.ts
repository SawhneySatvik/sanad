import { describe, expect, it } from "vitest";
import { LayeredCache } from "@/server/cache/layered";
import { MemoryKeyValueCache } from "@/server/cache/memory";
import type { KeyValueCache } from "@/server/cache/types";

// A KeyValueCache that counts calls, so a test can prove which tier actually answered a read
// without inspecting either tier's private state.
class CountingCache implements KeyValueCache {
  getCalls = 0;
  setCalls = 0;
  constructor(private readonly inner: KeyValueCache) {}
  async get(key: string): Promise<string | null> {
    this.getCalls++;
    return this.inner.get(key);
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.setCalls++;
    return this.inner.set(key, value, ttlSeconds);
  }
}

describe("LayeredCache", () => {
  it("a miss on both tiers is null, and touches both", async () => {
    const l1 = new CountingCache(new MemoryKeyValueCache());
    const l2 = new CountingCache(new MemoryKeyValueCache());
    const cache = new LayeredCache(l1, l2);

    expect(await cache.get("k")).toBeNull();
    expect(l1.getCalls).toBe(1);
    expect(l2.getCalls).toBe(1);
  });

  it("an L1 hit never reaches L2", async () => {
    const l1 = new CountingCache(new MemoryKeyValueCache());
    const l2 = new CountingCache(new MemoryKeyValueCache());
    const cache = new LayeredCache(l1, l2);

    await l1.set("k", "from-l1", 60);
    expect(await cache.get("k")).toBe("from-l1");
    expect(l2.getCalls).toBe(0);
  });

  it("an L2 hit backfills L1, so the next read never reaches L2 again", async () => {
    const l1Inner = new MemoryKeyValueCache();
    const l1 = new CountingCache(l1Inner);
    const l2 = new CountingCache(new MemoryKeyValueCache());
    const cache = new LayeredCache(l1, l2);

    await l2.set("k", "from-l2", 60);
    expect(await cache.get("k")).toBe("from-l2");
    expect(l2.getCalls).toBe(1);
    expect(await l1Inner.get("k")).toBe("from-l2"); // backfilled

    expect(await cache.get("k")).toBe("from-l2");
    expect(l2.getCalls).toBe(1); // unchanged: the second read was served from L1
  });

  it("set() writes both tiers", async () => {
    const l1 = new CountingCache(new MemoryKeyValueCache());
    const l2 = new CountingCache(new MemoryKeyValueCache());
    const cache = new LayeredCache(l1, l2);

    await cache.set("k", "v", 600);
    expect(l1.setCalls).toBe(1);
    expect(l2.setCalls).toBe(1);
    expect(await l1.get("k")).toBe("v");
    expect(await l2.get("k")).toBe("v");
  });
});
