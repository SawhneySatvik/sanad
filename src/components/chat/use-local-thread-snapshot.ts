"use client";

/**
 * A local thread's read-once-at-mount snapshot (the not-found case, plus the initial content a
 * reopened guest thread renders from), via useSyncExternalStore — the same hydration-safe pattern
 * src/components/shell/use-sidebar-collapsed.ts and local-threads.ts's useLocalThreads already use:
 * a server render has no localStorage to read, so it must report an identical, environment-
 * independent value on its first pass; useSyncExternalStore's separate server snapshot is what
 * makes that safe without a useEffect+setState round trip, which this repo's lint config flags as
 * an anti-pattern for exactly this kind of derived value.
 *
 * Cached per id so repeated getSnapshot() calls (React calls this every render to check for
 * changes) return the SAME reference until something real changes — a fresh object every call
 * would make useSyncExternalStore think the store mutates every render. Evicted on unmount: a
 * ChatScreen instance can go away and a later one mount for the SAME id (leaving one thread for the
 * chat home, then reopening it from the sidebar) — a cache entry surviving that would show whatever
 * content existed the first time it was ever read, ignoring anything appended since.
 */

import { useEffect, useSyncExternalStore } from "react";
import { hasLocalThread, loadLocalThread } from "@/lib/guest-threads";
import type { GuestThread } from "@/lib/guest-thread-store";

export type LocalThreadSnapshot = { status: "loading" } | { status: "not-found" } | { status: "loaded"; thread: GuestThread };

const LOADING_SNAPSHOT: LocalThreadSnapshot = { status: "loading" };
const NOT_FOUND_SNAPSHOT: LocalThreadSnapshot = { status: "not-found" };

const cache = new Map<string, LocalThreadSnapshot>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** This thread's own storage write path (saveLocalThread) is the only other writer of the keys this reads — nothing external mutates it out from under a mounted ChatScreen, so no other invalidation trigger is needed today. */
export function useLocalThreadSnapshot(id: string | null): LocalThreadSnapshot {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => {
      if (id === null) return NOT_FOUND_SNAPSHOT;
      const cached = cache.get(id);
      if (cached) return cached;
      const computed: LocalThreadSnapshot = hasLocalThread(id) ? { status: "loaded", thread: loadLocalThread(id) } : NOT_FOUND_SNAPSHOT;
      cache.set(id, computed);
      return computed;
    },
    () => LOADING_SNAPSHOT,
  );

  useEffect(() => {
    return () => {
      if (id !== null) cache.delete(id);
    };
  }, [id]);

  return snapshot;
}
