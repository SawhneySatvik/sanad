"use client";

/**
 * The remembered "I am a…" chip, namespaced saboot:situation:v1. useSyncExternalStore, matching
 * src/components/shell/use-sidebar-collapsed.ts's own pattern — the server has no viewer to read
 * localStorage for, so it always reports null on the server-rendered pass, and the real value only
 * appears once the client snapshot runs, post-hydration.
 */

import { useSyncExternalStore } from "react";
import type { SituationRole } from "./catalogue";

const SITUATION_KEY = "saboot:situation:v1";
const listeners = new Set<() => void>();

function isSituationRole(value: unknown): value is SituationRole {
  return value === "tenant" || value === "employee" || value === "freelancer" || value === "other";
}

function getSnapshot(): SituationRole | null {
  try {
    const raw = window.localStorage.getItem(SITUATION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const role = (parsed as { role?: unknown }).role;
    return isSituationRole(role) ? role : null;
  } catch {
    return null;
  }
}

function getServerSnapshot(): SituationRole | null {
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStoredRole(next: SituationRole | null): void {
  try {
    window.localStorage.setItem(SITUATION_KEY, JSON.stringify({ role: next }));
  } catch {
    // Best effort only — a QuotaExceededError leaves the in-memory value applied for this render,
    // just not persisted across a reload.
  }
  for (const listener of listeners) listener();
}

export function useSituation(): [SituationRole | null, (role: SituationRole | null) => void] {
  const role = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [role, setStoredRole];
}
