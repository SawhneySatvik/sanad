"use client";

import { useSyncExternalStore } from "react";

/**
 * The shared "are we offline" signal OfflineBanner renders from: navigator.onLine plus a decaying
 * "a fetch just failed with a network TypeError" flag, since the browser's own online/offline
 * events can be slow or simply wrong (a captive portal, a flaky connection that still reports
 * "online"). apiFetch calls reportNetworkFailure() itself so this fires for every apiFetch-based
 * call, not only ones a caller remembers to wire up by hand.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
let recentFailure = false;
let decayTimeout: ReturnType<typeof setTimeout> | null = null;

// 15s: long enough that a banner isn't flickering off before the user notices it, short enough
// that a single transient failure from minutes ago doesn't keep claiming "offline" forever once
// the connection has plainly recovered and nothing else has failed since.
const DECAY_MS = 15_000;

function notify(): void {
  for (const listener of listeners) listener();
}

export function reportNetworkFailure(): void {
  recentFailure = true;
  if (decayTimeout) clearTimeout(decayTimeout);
  decayTimeout = setTimeout(() => {
    recentFailure = false;
    decayTimeout = null;
    notify();
  }, DECAY_MS);
  notify();
}

// A real "online" event is fresher evidence than a failure from while the browser was offline:
// without this, a background fetch that failed during the outage kept the composer disabled for the
// rest of DECAY_MS after reconnecting. If the connection is still broken, the next failed fetch
// raises the flag again.
function clearRecentFailure(): void {
  recentFailure = false;
  if (decayTimeout) clearTimeout(decayTimeout);
  decayTimeout = null;
}

function subscribe(listener: Listener): () => void {
  const onOnline = () => {
    clearRecentFailure();
    listener();
  };
  listeners.add(listener);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", listener);
  };
}

function getSnapshot(): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return recentFailure;
}

// Never renders as offline during SSR or the initial hydration pass — only the client can know.
function getServerSnapshot(): boolean {
  return false;
}

export function useIsOffline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
