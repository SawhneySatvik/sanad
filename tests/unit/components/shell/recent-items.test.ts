import { describe, expect, it } from "vitest";
import { MAX_RECENT_ITEMS, expiresInHoursLabel, mergeRecentItems } from "@/components/shell/recent-items";
import type { LocalThreadEntry } from "@/components/shell/local-threads";
import { createEmptyThread, appendMessage } from "@/lib/guest-thread-store";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function documentRow(overrides: Partial<{ id: string; title: string | null; updatedAt: string; expiresAt: string | null }> = {}) {
  return { id: "doc-1", title: "Lease.pdf", updatedAt: "2025-12-31T00:00:00.000Z", expiresAt: null, ...overrides };
}

describe("mergeRecentItems", () => {
  it("maps each of the four server lists to their own route and sorts by updatedAt descending", () => {
    const items = mergeRecentItems({
      documents: [documentRow({ id: "doc-1", updatedAt: "2025-12-30T00:00:00.000Z" })],
      comparisons: [{ id: "cmp-1", title: "Compare", updatedAt: "2025-12-31T00:00:00.000Z", expiresAt: null }],
      drafts: [{ id: "draft-1", title: "Draft", updatedAt: "2026-01-01T00:00:00.000Z", expiresAt: null }],
      threads: [{ id: "thread-1", title: "Thread", updatedAt: "2025-12-29T00:00:00.000Z" }],
      localThreads: [],
      now: NOW,
    });

    expect(items.map((i) => i.id)).toEqual(["draft-1", "cmp-1", "doc-1", "thread-1"]);
    expect(items.find((i) => i.id === "doc-1")?.href).toBe("/documents/doc-1");
    expect(items.find((i) => i.id === "cmp-1")?.href).toBe("/compare/cmp-1");
    expect(items.find((i) => i.id === "draft-1")?.href).toBe("/drafts/draft-1");
    expect(items.find((i) => i.id === "thread-1")?.href).toBe("/chat/thread-1");
  });

  it("falls back thread title to 'New chat' when the server row's own title is null", () => {
    const items = mergeRecentItems({
      documents: [],
      comparisons: [],
      drafts: [],
      threads: [{ id: "thread-1", title: null, updatedAt: "2025-12-29T00:00:00.000Z" }],
      localThreads: [],
      now: NOW,
    });
    expect(items[0].title).toBe("New chat");
  });

  it("merges local threads in, keyed off the last message's createdAtMs", () => {
    const thread = appendMessage(createEmptyThread("local-abc", "My local chat"), {
      id: "m1",
      role: "user",
      content: "hi",
      mode: null,
      citations: [],
      createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    const local: LocalThreadEntry[] = [{ id: "local-abc", thread }];

    const items = mergeRecentItems({
      documents: [documentRow()],
      comparisons: [],
      drafts: [],
      threads: [],
      localThreads: local,
      now: NOW,
    });

    expect(items[0].id).toBe("local-abc");
    expect(items[0].isLocal).toBe(true);
    expect(items[0].href).toBe("/chat/local-abc");
  });

  it("a messageless local thread ranks by index position, most-recent-first, never crashing on a missing timestamp", () => {
    const first: LocalThreadEntry = { id: "local-a", thread: createEmptyThread("local-a", "First") };
    const second: LocalThreadEntry = { id: "local-b", thread: createEmptyThread("local-b", "Second") };

    const items = mergeRecentItems({
      documents: [],
      comparisons: [],
      drafts: [],
      threads: [],
      localThreads: [first, second],
      now: NOW,
    });

    expect(items.map((i) => i.id)).toEqual(["local-a", "local-b"]);
  });

  it("slices to MAX_RECENT_ITEMS even when more rows are supplied", () => {
    const documents = Array.from({ length: MAX_RECENT_ITEMS + 5 }, (_, i) =>
      documentRow({ id: `doc-${i}`, updatedAt: new Date(NOW - i * 1000).toISOString() }),
    );
    const items = mergeRecentItems({ documents, comparisons: [], drafts: [], threads: [], localThreads: [], now: NOW });
    expect(items).toHaveLength(MAX_RECENT_ITEMS);
    expect(items[0].id).toBe("doc-0");
  });

  it("only GET /api/threads is ever empty for a guest — documents/comparisons/drafts still contribute rows", () => {
    const items = mergeRecentItems({
      documents: [documentRow()],
      comparisons: [{ id: "cmp-1", title: "Compare", updatedAt: "2025-12-31T00:00:00.000Z", expiresAt: null }],
      drafts: [],
      threads: [],
      localThreads: [],
      now: NOW,
    });
    expect(items).toHaveLength(2);
  });
});

describe("expiresInHoursLabel", () => {
  it("rounds to the nearest hour, floored at 1", () => {
    expect(expiresInHoursLabel(new Date(NOW + 90 * 60_000).toISOString(), NOW)).toBe("Deletes in about 2 h");
  });

  it("never reads as 0 hours even for a near-immediate expiry", () => {
    expect(expiresInHoursLabel(new Date(NOW + 1_000).toISOString(), NOW)).toBe("Deletes in about 1 h");
  });
});
