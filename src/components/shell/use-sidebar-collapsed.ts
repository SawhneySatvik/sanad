"use client";

/**
 * Desktop icon-rail collapse state, persisted per-viewer. useSyncExternalStore's server/client
 * snapshot split (matching ThemeToggle's own useMounted pattern) is what keeps the collapsed class
 * out of the initial SSR payload: the server has no viewer to read localStorage for, so it always
 * reports "expanded," and the real value only appears once the client snapshot runs, post-hydration.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "saboot:sidebar-collapsed:v1";
const listeners = new Set<() => void>();

// Set once localStorage.getItem/setItem has actually thrown — private browsing, a locked-down
// setting, or a full quota. getSnapshot then stops re-querying storage (which would just throw
// again on every render) and returns this instead, so collapse still works for the rest of the tab.
let storageDisabled = false;
let memoryCollapsed = false;

function getSnapshot(): boolean {
  if (storageDisabled) return memoryCollapsed;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    storageDisabled = true;
    return memoryCollapsed;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setCollapsed(next: boolean): void {
  memoryCollapsed = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Storage disabled/quota-exceeded: nothing persists past this tab, but memoryCollapsed above
    // still makes the toggle work for the rest of this session.
    storageDisabled = true;
  }
  for (const listener of listeners) listener();
}

export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [collapsed, setCollapsed];
}
