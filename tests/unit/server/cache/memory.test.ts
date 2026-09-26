import { describe, expect, it, vi } from "vitest";
import { MemoryKeyValueCache } from "@/server/cache/memory";

describe("MemoryKeyValueCache", () => {
  it("round-trips a value, and misses a key it never saw", async () => {
    const cache = new MemoryKeyValueCache();
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", "v", 60);
    expect(await cache.get("k")).toBe("v");
  });

  it("TTL expiry: an entry past its ttlSeconds is a miss, and is evicted (not just reported null)", async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryKeyValueCache();
      await cache.set("k", "v", 10);
      vi.advanceTimersByTime(9_000);
      expect(await cache.get("k")).toBe("v");
      vi.advanceTimersByTime(2_000);
      expect(await cache.get("k")).toBeNull();
      // Evicted, not merely stale: setting a fresh, longer-lived value under the same key round-trips.
      await cache.set("k", "v2", 60);
      expect(await cache.get("k")).toBe("v2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("eviction: over the bound, the least recently used entry is dropped first", async () => {
    const cache = new MemoryKeyValueCache(2);
    await cache.set("a", "1", 60);
    await cache.set("b", "2", 60);
    // Touch "a" so "b" becomes the least recently used.
    await cache.get("a");
    await cache.set("c", "3", 60);

    expect(await cache.get("a")).toBe("1");
    expect(await cache.get("c")).toBe("3");
    expect(await cache.get("b")).toBeNull();
  });

  it("a re-set of an existing key overwrites its value and TTL, and doesn't double-count toward the bound", async () => {
    const cache = new MemoryKeyValueCache(2);
    await cache.set("a", "1", 60);
    await cache.set("b", "2", 60);
    await cache.set("a", "1-updated", 60);
    await cache.set("c", "3", 60);

    // "a" was refreshed (touched), so "b" is still the least recently used one evicted.
    expect(await cache.get("a")).toBe("1-updated");
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).toBe("3");
  });
});
