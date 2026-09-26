/**
 * Read-only access to a guest's locally-held threads for RecentsList's merge, plus the two narrow
 * chrome-level writes this sidebar owns (rename/delete a row) — never the thread *content* itself
 * (messages, attachments), which the chat surface owns end to end.
 *
 * `chatId` in the URL is the same string as the index/storage suffix ("local-<uuid>") — there is no
 * separate prefixing step here.
 */

import { useSyncExternalStore } from "react";
import { loadThread, saveThread, type GuestThread } from "@/lib/guest-thread-store";
import { subscribeToLocalThreadWrites } from "@/lib/guest-threads/local-thread";
import { onSessionBroadcast } from "@/lib/session/sync";

const INDEX_KEY = "saboot:threads:v1:index";
// Smaller than the module's own 2MB default, since up to 20 threads at that default would risk
// the browser's whole-origin storage quota.
const MAX_THREAD_BYTES = 200_000;

function threadStorageKey(id: string): string {
  return `saboot:threads:v1:${id}`;
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
    // Best effort only — the in-memory caller has already moved on; nothing to recover here.
  }
}

export interface LocalThreadEntry {
  /** The index's own id — the source of truth for the URL/storage key, never GuestThread.id (which
   * falls back to the storage key itself if the row was somehow missing). */
  id: string;
  thread: GuestThread;
}

function readLocalThreads(): LocalThreadEntry[] {
  return readIndex().map((id) => ({
    id,
    thread: loadThread(window.localStorage, threadStorageKey(id), MAX_THREAD_BYTES),
  }));
}

// useSyncExternalStore requires a stable snapshot reference across calls that see no real change —
// a fresh array/object graph on every read would otherwise re-render forever. This module caches the
// last read and only recomputes (a new reference) when a write below explicitly invalidates it.
const EMPTY_THREADS: LocalThreadEntry[] = [];
let cachedThreads: LocalThreadEntry[] | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): LocalThreadEntry[] {
  if (cachedThreads === null) cachedThreads = readLocalThreads();
  return cachedThreads;
}
function getServerSnapshot(): LocalThreadEntry[] {
  return EMPTY_THREADS;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // The chat surface's own writer (src/lib/guest-threads/local-thread.ts) saves/deletes through a
  // different module than this one's rename/delete — lib code never imports from
  // src/components/**, so its own notification channel is the only way a same-tab send/save
  // reaches RecentsList without a full reload.
  const unsubscribeWrites = subscribeToLocalThreadWrites(refreshLocalThreads);
  return () => {
    listeners.delete(listener);
    unsubscribeWrites();
  };
}

/**
 * Forces the next read to hit localStorage again — every write in this module calls it already;
 * the chat surface's own writes (a fresh send, a save) reach here through subscribeToLocalThreadWrites
 * above instead, so RecentsList picks up a freshly-created or freshly-appended-to local thread
 * without a full reload.
 */
export function refreshLocalThreads(): void {
  cachedThreads = null;
  for (const listener of listeners) listener();
}

/** Every local thread the index names, most-recent-activity-first — read fresh on mount only,
 * client-only (localStorage isn't available during SSR): the server snapshot is always empty. */
export function useLocalThreads(): LocalThreadEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** A local thread's own "last activity": its last message's createdAtMs, or — a thread with no
 * messages yet — a value derived from the index's own most-recent-first order, since GuestThread
 * carries no creation timestamp of its own. */
export function localThreadActivityMs(entry: LocalThreadEntry, indexPosition: number, now: number): number {
  const last = entry.thread.messages[entry.thread.messages.length - 1];
  if (last) return last.createdAtMs;
  return now - indexPosition;
}

/** Sidebar-level rename: mutates the stored thread directly, never an API call. */
export function renameLocalThread(id: string, title: string): void {
  if (typeof window === "undefined") return;
  const key = threadStorageKey(id);
  const thread = loadThread(window.localStorage, key, MAX_THREAD_BYTES);
  saveThread(window.localStorage, key, { ...thread, title }, MAX_THREAD_BYTES);
  refreshLocalThreads();
}

/** Sidebar-level delete: removes the thread and its index entry, never an API call. */
export function deleteLocalThread(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(threadStorageKey(id));
  } catch {
    // Best effort; the index write below still drops it from every future read.
  }
  writeIndex(readIndex().filter((existing) => existing !== id));
  refreshLocalThreads();
}

const THREAD_KEY_PREFIX = "saboot:threads:v1:";

/**
 * A real cross-tab write never reaches this module's own snapshot cache otherwise: "Delete all my
 * data" clears local-thread storage with a raw key sweep in another tab, never through
 * renameLocalThread/deleteLocalThread above — the only two writers this cache already knows to
 * invalidate itself for. The native `storage` event is how a *listening* tab hears about a change
 * some other tab made to the same origin's storage (it never fires for a tab's own writes, only a
 * sibling tab's) — `event.key === null` is a whole-storage `.clear()`, otherwise only a key under
 * this module's own prefix is worth a re-render.
 */
function onStorageEvent(event: StorageEvent): void {
  if (event.key !== null && !event.key.startsWith(THREAD_KEY_PREFIX)) return;
  refreshLocalThreads();
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", onStorageEvent);
  // Belt and suspenders with the storage listener above: a same-tab delete-all's raw sweep never
  // fires a native storage event in THIS tab (only sibling tabs get that), so this tab's own copy
  // needs the broadcast-side signal instead — lib/session/sync.ts exposes this registration hook
  // rather than this module importing sync's internals, keeping the dependency one-directional.
  onSessionBroadcast(refreshLocalThreads);
}
