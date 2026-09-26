import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  deleteLocalThread,
  localThreadActivityMs,
  refreshLocalThreads,
  renameLocalThread,
  useLocalThreads,
  type LocalThreadEntry,
} from "@/components/shell/local-threads";
import { createEmptyThread, appendMessage, saveThread } from "@/lib/guest-thread-store";
import { saveLocalThread } from "@/lib/guest-threads/local-thread";
import { subscribeToSessionBroadcast } from "@/lib/session/sync";
import { QueryClient } from "@tanstack/react-query";

beforeEach(() => {
  window.localStorage.clear();
  // The module's own snapshot cache is a singleton across tests in this file — force a fresh read
  // so one test's seeded storage never leaks into the next via a stale cached array.
  refreshLocalThreads();
});
afterEach(() => {
  window.localStorage.clear();
});

function seedThread(id: string, title = "Untitled") {
  saveThread(window.localStorage, `saboot:threads:v1:${id}`, createEmptyThread(id, title));
}

function seedIndex(ids: string[]) {
  window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(ids));
}

describe("useLocalThreads", () => {
  it("reads nothing when the index key is absent", () => {
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current).toEqual([]);
  });

  it("reads every thread the index names, in index order", () => {
    seedThread("local-a", "First");
    seedThread("local-b", "Second");
    seedIndex(["local-a", "local-b"]);

    const { result } = renderHook(() => useLocalThreads());
    expect(result.current.map((e) => e.id)).toEqual(["local-a", "local-b"]);
    expect(result.current[0].thread.title).toBe("First");
  });

  it("ignores a corrupt index (non-array JSON) rather than throwing", () => {
    window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify({ not: "an array" }));
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current).toEqual([]);
  });

  it("re-renders after renameLocalThread invalidates the shared store", () => {
    seedThread("local-a", "Old title");
    seedIndex(["local-a"]);
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current[0].thread.title).toBe("Old title");

    act(() => renameLocalThread("local-a", "New title"));
    expect(result.current[0].thread.title).toBe("New title");
  });

  it("re-renders after deleteLocalThread removes the row and its index entry", () => {
    seedThread("local-a", "A");
    seedThread("local-b", "B");
    seedIndex(["local-a", "local-b"]);
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current).toHaveLength(2);

    act(() => deleteLocalThread("local-a"));
    expect(result.current.map((e) => e.id)).toEqual(["local-b"]);
    expect(window.localStorage.getItem("saboot:threads:v1:local-a")).toBeNull();
  });

  it("refreshes when another tab's native storage event touches a saboot:threads:v1: key, without any call in this tab", () => {
    seedThread("local-a", "Old title");
    seedIndex(["local-a"]);
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current).toHaveLength(1);

    // Simulates a sibling tab clearing local-thread storage directly (Settings' delete-all does
    // exactly this) — a real cross-tab write never calls this module's own mutators at all, so the
    // native `storage` event is the only signal this tab gets.
    window.localStorage.removeItem("saboot:threads:v1:local-a");
    seedIndex([]);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "saboot:threads:v1:index" }));
    });

    expect(result.current).toHaveLength(0);
  });

  it("re-renders in the same tab after the chat surface's own saveLocalThread — no reload, no storage event needed", () => {
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current).toHaveLength(0);

    act(() => {
      saveLocalThread("local-new", createEmptyThread("local-new", "Fresh send"));
    });

    expect(result.current.map((e) => e.id)).toEqual(["local-new"]);
  });

  it("re-renders when the cross-tab session broadcast fires — registered via lib/session/sync.ts's onSessionBroadcast() hook, not by this module importing sync.ts's internals", () => {
    seedThread("local-a", "Old title");
    seedIndex(["local-a"]);
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current).toHaveLength(1);

    // Simulates the raw storage sweep a real cross-tab delete-all performs — never through this
    // module's own rename/delete mutators, so only the broadcast registration can notice it.
    window.localStorage.clear();

    vi.stubGlobal("BroadcastChannel", undefined);
    const unsubscribe = subscribeToSessionBroadcast(new QueryClient());
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "saboot:session-broadcast" }));
    });

    expect(result.current).toHaveLength(0);
    unsubscribe();
    vi.unstubAllGlobals();
  });

  it("preserves the id from the index rather than trusting a possibly-missing thread's own id", () => {
    // No thread stored at all for "local-ghost" — loadThread falls back to an empty thread whose
    // own `.id` is the storage key, not the bare id; the index's id must still be what callers see.
    seedIndex(["local-ghost"]);
    const { result } = renderHook(() => useLocalThreads());
    expect(result.current[0].id).toBe("local-ghost");
  });
});

describe("localThreadActivityMs", () => {
  it("uses the last message's createdAtMs when present", () => {
    const withMessage = appendMessage(createEmptyThread("local-a"), {
      id: "m1",
      role: "user",
      content: "hi",
      mode: null,
      citations: [],
      createdAtMs: 1000,
    });
    const entry: LocalThreadEntry = { id: "local-a", thread: withMessage };
    expect(localThreadActivityMs(entry, 0, 5000)).toBe(1000);
  });

  it("falls back to now minus index position for a thread with no messages yet", () => {
    const entry: LocalThreadEntry = { id: "local-a", thread: createEmptyThread("local-a") };
    expect(localThreadActivityMs(entry, 3, 5000)).toBe(4997);
  });
});
