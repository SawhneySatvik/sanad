// A real jsdom localStorage (not a fake StorageBackend injection) — this module deliberately talks
// to window.localStorage directly, since it must interoperate with
// src/components/shell/local-threads.ts's own reads under the exact same keys. No JSX here;
// the .tsx extension is only to opt into vitest's jsdom project (a real Storage implementation).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendMessage, deserializeThread, loadThread, type GuestMessage, type GuestThread } from "@/lib/guest-thread-store";
import {
  deleteLocalThreadAfterImport,
  hasLocalThread,
  isLocalThreadId,
  loadLocalThread,
  mintLocalThreadId,
  saveLocalThread,
  subscribeToLocalThreadWrites,
} from "@/lib/guest-threads/local-thread";

function userMessage(id: string, content: string): GuestMessage {
  return { id, role: "user", content, mode: null, citations: [], createdAtMs: Date.now() };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("mintLocalThreadId / isLocalThreadId", () => {
  it("mints an id starting with 'local-', recognised by isLocalThreadId", () => {
    const id = mintLocalThreadId();
    expect(id.startsWith("local-")).toBe(true);
    expect(isLocalThreadId(id)).toBe(true);
    expect(isLocalThreadId("a-real-server-uuid")).toBe(false);
  });

  it("mints a fresh id each call", () => {
    expect(mintLocalThreadId()).not.toBe(mintLocalThreadId());
  });
});

describe("hasLocalThread — the absent-vs-empty distinction", () => {
  it("false for a key that was never written", () => {
    expect(hasLocalThread("local-never-written")).toBe(false);
  });

  it("true once saveLocalThread has written the key, even for an otherwise-empty thread", () => {
    const id = mintLocalThreadId();
    const thread = { id, title: "New chat", documentIds: [], messages: [] };
    saveLocalThread(id, thread);
    expect(hasLocalThread(id)).toBe(true);
  });
});

describe("saveLocalThread / loadLocalThread round trip", () => {
  it("round-trips messages and citations unchanged", () => {
    const id = mintLocalThreadId();
    let thread = { id, title: "My chat", documentIds: ["doc-1"], messages: [] as GuestMessage[] };
    thread = appendMessage(thread, userMessage("m1", "hello"));
    thread = appendMessage(thread, {
      id: "m2",
      role: "assistant",
      content: "answer",
      mode: "grounded",
      citations: [{ quoteText: "the term is 30 days", sourceDocumentId: "doc-1", unverifiedCachedStatus: "cached_verified" }],
      createdAtMs: Date.now(),
    });

    saveLocalThread(id, thread);
    expect(loadLocalThread(id)).toEqual(thread);
  });

  it("interop: JSON this module writes is read back unchanged through shell's own guest-thread-store deserializeThread/loadThread (the cross-surface compatibility invariant)", () => {
    const id = mintLocalThreadId();
    let thread: GuestThread = { id, title: "My chat", documentIds: [], messages: [] };
    thread = appendMessage(thread, userMessage("m1", "hello"));
    thread = appendMessage(thread, {
      id: "m2",
      role: "assistant",
      content: "answer",
      mode: "grounded",
      citations: [{ quoteText: "q", sourceDocumentId: "doc-1", unverifiedCachedStatus: "cached_approximate" }],
      createdAtMs: Date.now(),
    });
    saveLocalThread(id, thread);

    const key = `saboot:threads:v1:${id}`;
    const raw = window.localStorage.getItem(key);
    expect(raw).not.toBeNull();
    const viaOldStore = deserializeThread(raw, "unused-fallback");
    expect(viaOldStore.messages).toHaveLength(2);
    expect(viaOldStore.messages[1].citations).toHaveLength(1);
    expect(loadThread(window.localStorage, key)).toEqual(thread);
  });

  it("trims to the 50-message cap on top of saveThread's own byte cap, keeping the newest", () => {
    const id = mintLocalThreadId();
    let thread: GuestThread = { id, title: "T", documentIds: [], messages: [] };
    for (let i = 0; i < 60; i++) thread = appendMessage(thread, userMessage(`m${i}`, `turn-${i}`));

    saveLocalThread(id, thread);
    const loaded = loadLocalThread(id);
    expect(loaded.messages).toHaveLength(50);
    expect(loaded.messages[0].id).toBe("m10");
    expect(loaded.messages[loaded.messages.length - 1].id).toBe("m59");
  });

  it("loadLocalThread for a never-written id returns an empty thread (never throws) — the fallback id is the storage KEY, matching guest-thread-store.ts's own documented edge case (shell's local-threads.ts LocalThreadEntry.id comment), never the bare thread id", () => {
    const id = mintLocalThreadId();
    expect(loadLocalThread(id)).toEqual({ id: `saboot:threads:v1:${id}`, title: "New thread", documentIds: [], messages: [] });
  });
});

describe("saveLocalThread — the 20-thread index cap and eviction", () => {
  it("bumps a re-saved thread to the front without evicting anything", () => {
    const ids = Array.from({ length: 5 }, () => mintLocalThreadId());
    for (const id of ids) saveLocalThread(id, { id, title: "T", documentIds: [], messages: [] });

    const result = saveLocalThread(ids[0], { id: ids[0], title: "T (updated)", documentIds: [], messages: [] });
    expect(result.evictedIds).toEqual([]);
    for (const id of ids) expect(hasLocalThread(id)).toBe(true);
  });

  it("evicts the oldest thread once a 21st distinct thread is saved", () => {
    const ids = Array.from({ length: 20 }, () => mintLocalThreadId());
    for (const id of ids) saveLocalThread(id, { id, title: "T", documentIds: [], messages: [] });

    const newest = mintLocalThreadId();
    const result = saveLocalThread(newest, { id: newest, title: "T", documentIds: [], messages: [] });

    expect(result.evictedIds).toEqual([ids[0]]);
    expect(hasLocalThread(ids[0])).toBe(false); // the oldest is gone
    expect(hasLocalThread(newest)).toBe(true);
    for (const id of ids.slice(1)) expect(hasLocalThread(id)).toBe(true); // every other survives
  });
});

describe("deleteLocalThreadAfterImport", () => {
  it("removes the thread's own storage entry and its index row", () => {
    const id = mintLocalThreadId();
    saveLocalThread(id, { id, title: "T", documentIds: [], messages: [] });
    expect(hasLocalThread(id)).toBe(true);

    deleteLocalThreadAfterImport(id);
    expect(hasLocalThread(id)).toBe(false);

    const index: string[] = JSON.parse(window.localStorage.getItem("saboot:threads:v1:index") ?? "[]");
    expect(index).not.toContain(id);
  });
});

describe("subscribeToLocalThreadWrites — the sidebar's same-tab signal", () => {
  it("notifies a subscribed listener on save and on post-import delete", () => {
    const id = mintLocalThreadId();
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalThreadWrites(listener);

    saveLocalThread(id, { id, title: "T", documentIds: [], messages: [] });
    expect(listener).toHaveBeenCalledTimes(1);

    deleteLocalThreadAfterImport(id);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("stops notifying once unsubscribed — the browser's native storage event never fires for a same-document write, so this is the only channel", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalThreadWrites(listener);
    unsubscribe();

    saveLocalThread(mintLocalThreadId(), { id: "x", title: "T", documentIds: [], messages: [] });
    expect(listener).not.toHaveBeenCalled();
  });

  it("a second subscriber's own unsubscribe never silences the first", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeToLocalThreadWrites(first);
    const unsubscribeSecond = subscribeToLocalThreadWrites(second);
    unsubscribeSecond();

    saveLocalThread(mintLocalThreadId(), { id: "x", title: "T", documentIds: [], messages: [] });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe("saveLocalThread — a corrupt index recovers instead of throwing", () => {
  it("an unparseable index is treated as empty, and the save still succeeds", () => {
    window.localStorage.setItem("saboot:threads:v1:index", "{not json");
    const id = mintLocalThreadId();

    const result = saveLocalThread(id, { id, title: "T", documentIds: [], messages: [] });

    expect(result.evictedIds).toEqual([]);
    expect(hasLocalThread(id)).toBe(true);
  });

  it("an index that parses to a non-array is treated as empty", () => {
    window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify({ not: "an array" }));
    const id = mintLocalThreadId();

    saveLocalThread(id, { id, title: "T", documentIds: [], messages: [] });

    const index: unknown = JSON.parse(window.localStorage.getItem("saboot:threads:v1:index")!);
    expect(index).toEqual([id]);
  });

  it("non-string entries in an otherwise-array index are dropped rather than carried forward", () => {
    window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-real", 42, null, "local-other"]));
    const id = mintLocalThreadId();

    saveLocalThread(id, { id, title: "T", documentIds: [], messages: [] });

    const index: unknown[] = JSON.parse(window.localStorage.getItem("saboot:threads:v1:index")!);
    expect(index).toEqual([id, "local-real", "local-other"]);
  });
});

describe("saveLocalThread — eviction survives a removeItem failure on the evicted key", () => {
  it("still reports the id as evicted, and the index write already dropped it from every future read", () => {
    const ids = Array.from({ length: 20 }, () => mintLocalThreadId());
    for (const existingId of ids) saveLocalThread(existingId, { id: existingId, title: "T", documentIds: [], messages: [] });

    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
      throw new Error("quota/security error");
    });
    const newest = mintLocalThreadId();
    const result = saveLocalThread(newest, { id: newest, title: "T", documentIds: [], messages: [] });
    removeItemSpy.mockRestore();

    expect(result.evictedIds).toEqual([ids[0]]);
    const index: string[] = JSON.parse(window.localStorage.getItem("saboot:threads:v1:index")!);
    expect(index).not.toContain(ids[0]);
  });
});
