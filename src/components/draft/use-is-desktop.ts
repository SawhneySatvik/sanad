"use client";

import { useSyncExternalStore } from "react";

// Matches the rest of the app's own split-pane threshold: 1024px. A small local copy rather than
// importing src/components/workspace/layout/use-is-desktop.ts — that file belongs to a different,
// concurrently-built surface.
const QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

// The server has no viewport; rendering the desktop shape there and correcting on hydration matches
// this codebase's own convention for this exact hook shape elsewhere.
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
