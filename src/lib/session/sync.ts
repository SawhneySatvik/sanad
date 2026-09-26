"use client";

/**
 * The cross-tab session boundary: sign-in, sign-out, claim and delete-all all broadcast on
 * BroadcastChannel("saboot:session"), with a localStorage `storage` event as the fallback for a
 * context where BroadcastChannel is unavailable. A `BroadcastChannel` object never receives its own
 * `postMessage` — but the caller below and the listener mounted at AppShell are two separate
 * channel objects, so the tab that caused the change *does* hear its own broadcast, on a delay that
 * depends on the message round trip. The explicit clear-and-refetch inside `notifySessionChanged`
 * below isn't a fallback for that, then — it's what lets that function's own returned promise be
 * trustworthy for a caller that navigates immediately afterward, without depending on the
 * broadcast's timing.
 */

import type { QueryClient } from "@tanstack/react-query";
import { SESSION_QUERY_KEY } from "./use-session";

export const SESSION_BROADCAST_CHANNEL = "saboot:session";
const STORAGE_FALLBACK_KEY = "saboot:session-broadcast";

function hasBroadcastChannel(): boolean {
  return typeof window !== "undefined" && typeof window.BroadcastChannel === "function";
}

// lib code never imports from src/components/** — a listening tab's own local-threads.ts cache
// (which needs invalidating on every broadcast, see clearAndRefetchSessionForBroadcast below)
// registers itself here instead of this module reaching into components directly.
const broadcastListeners = new Set<() => void>();

/**
 * Registered by shell-level code that needs to react to every cross-tab session-changing broadcast
 * (sign-in, sign-out, claim, delete-all) without this lib module importing components. Returns an
 * unsubscribe function.
 */
export function onSessionBroadcast(listener: () => void): () => void {
  broadcastListeners.add(listener);
  return () => broadcastListeners.delete(listener);
}

/**
 * Full cache wipe, never a named list of keys — a stale cross-principal cache entry (the session
 * query, or any of RecentsList's four list queries) is a privacy leak a hand-maintained list could
 * miss. Not `queryClient.clear()`: `clear()` destroys every Query object outright, and a
 * currently-mounted observer (`useSession()`, or RecentsList's own list queries) does not reliably
 * resubscribe to a brand-new Query that later reappears under the same key. `resetQueries()` resets
 * every Query back to its initial (no-data) state *in place* rather than destroying it, and
 * refetches through whichever observers are currently mounted — the one operation that both wipes
 * every key and reliably updates a still-mounted observer of any of them. Its returned promise is
 * deliberately left unawaited by callers below: it only settles once every active query's own
 * refetch (and retries) have settled, including RecentsList's list queries.
 */
function clearAndRefetchSession(queryClient: QueryClient): Promise<unknown> {
  return queryClient.resetQueries();
}

/**
 * The listening tab's own variant: a cross-tab delete-all clears local-thread storage with a raw
 * sweep (`clearSabootLocalStorage`), never through local-threads.ts's own rename/delete mutators —
 * so nothing else tells a *listening* tab's RecentsList to drop its cached local-thread snapshot.
 * `broadcastListeners` above is how that module hears about it without this one importing it
 * directly. Paired with local-threads.ts's own native `storage` listener (which covers the same
 * case even if this broadcast is the storage-event fallback rather than a real BroadcastChannel
 * message).
 */
function clearAndRefetchSessionForBroadcast(queryClient: QueryClient): Promise<unknown> {
  for (const listener of broadcastListeners) listener();
  return clearAndRefetchSession(queryClient);
}

/**
 * Call after sign-in, sign-out, claim or delete-all succeeds locally. Runs the clear-and-refetch in
 * this tab immediately, then notifies every other open tab through the channel (or its storage-event
 * fallback) so none of them keeps rendering a stale, now-wrong-principal cache. Returns once this
 * tab's own session query specifically has its fresh value — a caller that navigates right afterward
 * (delete-all does) should await this first, so the destination page never mounts against a stale
 * session read. Every other reset query keeps refetching in the background regardless of whether
 * anyone awaits this call.
 */
export async function notifySessionChanged(queryClient: QueryClient): Promise<void> {
  clearAndRefetchSession(queryClient);

  if (hasBroadcastChannel()) {
    const channel = new BroadcastChannel(SESSION_BROADCAST_CHANNEL);
    channel.postMessage({ type: "session-changed" });
    channel.close();
  } else {
    try {
      window.localStorage.setItem(STORAGE_FALLBACK_KEY, String(Date.now()));
    } catch {
      // Storage disabled/quota-exceeded: the current tab is already synced above; other tabs
      // simply don't hear about it, the same degraded behaviour a private-browsing session has.
    }
  }

  // Not `await`ing the reset above: it refetches every active query, including RecentsList's list
  // queries, which use the client-wide default retry (3 attempts, exponential backoff) — a single
  // transient failure on any one of them would hold a caller that's about to navigate (delete-all
  // does) behind several seconds of backoff for a query that page is about to leave anyway.
  // `refetchQueries` itself never rejects (a per-query failure is swallowed internally, same as
  // `resetQueries`'s own refetch above) — awaiting just session's own key here waits for the one
  // value a navigating caller actually depends on, without also waiting on the other list queries'
  // retries.
  await queryClient.refetchQueries({ queryKey: SESSION_QUERY_KEY, type: "active" });
}

/**
 * Mounted once, at AppShell — listens for another tab's `notifySessionChanged` call and mirrors the
 * same clear-and-refetch here. Nothing here needs to navigate afterward, so the refresh's own
 * promise is left unawaited.
 */
export function subscribeToSessionBroadcast(queryClient: QueryClient): () => void {
  if (hasBroadcastChannel()) {
    const channel = new BroadcastChannel(SESSION_BROADCAST_CHANNEL);
    channel.onmessage = () => void clearAndRefetchSessionForBroadcast(queryClient);
    return () => channel.close();
  }

  function onStorage(event: StorageEvent): void {
    if (event.key === STORAGE_FALLBACK_KEY) void clearAndRefetchSessionForBroadcast(queryClient);
  }
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
