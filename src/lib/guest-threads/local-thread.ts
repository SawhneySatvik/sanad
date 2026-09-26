/**
 * The chat surface's own read/write adapter over src/lib/guest-thread-store.ts's on-disk format.
 * Kept as a thin adapter, not a replacement store: src/components/shell/local-threads.ts
 * (RecentsList's rename/delete) reads the exact same `saboot:threads:v1:*` keys through that
 * module's own loadThread/saveThread — changing the on-disk shape here would silently break that
 * other surface's rename (it would load what its own type guard sees as an empty thread and write
 * that back, wiping every message). This module only ever adds messages/citations in the shapes
 * guest-thread-store.ts already validates; it never changes the wire format.
 *
 * subscribeToLocalThreadWrites is this module's own notification channel — lib code never imports
 * from src/components/**, so a write here can't reach RecentsList by importing its module directly;
 * the sidebar instead imports this function and folds it into its own useSyncExternalStore
 * subscription, alongside its existing native `storage` listener (which only ever fires for a
 * write from a DIFFERENT tab/document, never this one).
 */

import { createEmptyThread, loadThread, saveThread, type GuestThread } from "@/lib/guest-thread-store";

const localWriteListeners = new Set<() => void>();

/** Called by every write in this module — the one same-tab signal a caller (the sidebar) can subscribe to, since the browser's own `storage` event never fires for a write made in this same document. */
function notifyLocalThreadWrites(): void {
  for (const listener of localWriteListeners) listener();
}

/** Subscribes to every write this module makes (save, post-import delete) — returns an unsubscribe function. */
export function subscribeToLocalThreadWrites(listener: () => void): () => void {
  localWriteListeners.add(listener);
  return () => localWriteListeners.delete(listener);
}

const INDEX_KEY = "saboot:threads:v1:index";
const MAX_LOCAL_THREADS = 20;
const MAX_LOCAL_THREAD_MESSAGES = 50;
// Mirrors src/components/shell/local-threads.ts's own MAX_THREAD_BYTES exactly — smaller than
// guest-thread-store's 2MB default, since 20 threads at that default would risk the browser's
// whole-origin storage quota. That module exports no constant of its own to import, so this is a
// deliberate literal match, not a shared import.
const MAX_LOCAL_THREAD_BYTES = 200_000;

function threadStorageKey(id: string): string {
  return `saboot:threads:v1:${id}`;
}

export function mintLocalThreadId(): string {
  return `local-${crypto.randomUUID()}`;
}

export function isLocalThreadId(id: string): boolean {
  return id.startsWith("local-");
}

function readIndex(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function writeIndex(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
  } catch {
    // Best effort only — mirrors shell's own local-threads.ts note: the in-memory caller has
    // already moved on, nothing to recover here.
  }
}

/**
 * True only when the storage key has genuinely never been written. Distinct from a
 * present-but-corrupt/unparseable entry, which recovers to an empty thread rather than 404ing
 * (loadThread's own documented behaviour) — only a key that was never set at all is a real 404, not
 * merely a thread with nothing useful in it yet.
 */
export function hasLocalThread(id: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(threadStorageKey(id)) !== null;
}

export function loadLocalThread(id: string): GuestThread {
  if (typeof window === "undefined") return createEmptyThread(id);
  return loadThread(window.localStorage, threadStorageKey(id), MAX_LOCAL_THREAD_BYTES);
}

function trimToMessageCap(thread: GuestThread): GuestThread {
  if (thread.messages.length <= MAX_LOCAL_THREAD_MESSAGES) return thread;
  return { ...thread, messages: thread.messages.slice(thread.messages.length - MAX_LOCAL_THREAD_MESSAGES) };
}

export interface SaveLocalThreadResult {
  /** Ids evicted by the 20-thread cap, oldest first — the caller shows one toast per save that evicts. */
  evictedIds: string[];
}

/**
 * Persists `thread` under `id`: trims to the 50-message cap on top of saveThread's own byte-based
 * trim, bumps `id` to the front of the most-recent-first index, and evicts the oldest thread(s)
 * beyond the 20-thread cap. Always calls notifyLocalThreadWrites() so a subscriber (the sidebar)
 * picks up the write without a reload.
 */
export function saveLocalThread(id: string, thread: GuestThread): SaveLocalThreadResult {
  if (typeof window === "undefined") return { evictedIds: [] };
  saveThread(window.localStorage, threadStorageKey(id), trimToMessageCap(thread), MAX_LOCAL_THREAD_BYTES);

  const withoutId = readIndex().filter((existing) => existing !== id);
  const nextIndex = [id, ...withoutId];
  const evictedIds = nextIndex.slice(MAX_LOCAL_THREADS);
  writeIndex(nextIndex.slice(0, MAX_LOCAL_THREADS));
  for (const evictedId of evictedIds) {
    try {
      window.localStorage.removeItem(threadStorageKey(evictedId));
    } catch {
      // Best effort; the index write above already dropped it from every future read.
    }
  }

  notifyLocalThreadWrites();
  return { evictedIds };
}

/**
 * Deletes a local thread's own storage entry and index row — used only when saving a local thread
 * to a real account succeeds, so the same conversation never shows up twice (once local, once
 * saved). Routine sidebar rename/delete stays shell's own local-threads.ts; this is a distinct,
 * narrower operation (post-save cleanup), not a duplicate of that surface.
 */
export function deleteLocalThreadAfterImport(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(threadStorageKey(id));
  } catch {
    // Best effort.
  }
  writeIndex(readIndex().filter((existing) => existing !== id));
  notifyLocalThreadWrites();
}
