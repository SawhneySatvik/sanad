// A real jsdom localStorage (not a fake StorageBackend injection) — this module deliberately talks
// to window.localStorage directly, since it must interoperate with
// src/components/shell/local-threads.ts's own reads under the exact same keys. No JSX here;
// the .tsx extension is only to opt into vitest's jsdom project (a real Storage implementation).

import { beforeEach, describe, expect, it } from "vitest";
import { appendMessage, deserializeThread, loadThread, type GuestMessage, type GuestThread } from "@/lib/guest-thread-store";
import {
  deleteLocalThreadAfterImport,
  hasLocalThread,
  isLocalThreadId,
  loadLocalThread,
  mintLocalThreadId,
  saveLocalThread,
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
