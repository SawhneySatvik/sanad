"use client";

import { useSyncExternalStore } from "react";

// The workspace's own split-pane threshold: 1024px, not src/hooks/use-mobile's
// 768px chrome breakpoint — this screen renders exactly one of the desktop split or the phone
// bottom-sheet pattern, never both hidden behind CSS, so the boundary it reads must match the one
// the layout itself switches on.
const QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

// The server has no viewport; rendering the desktop shape there and correcting on hydration (rather
// than guessing phone) matches src/hooks/use-mobile's own convention for this codebase.
export function useIsDesktopWorkspace(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
