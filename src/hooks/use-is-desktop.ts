"use client";

import { useSyncExternalStore } from "react";

// The app's own split-pane threshold: 1024px — shared by Draft's revision timeline and the analysis
// workspace, the two screens that each render exactly one of a desktop split or a phone bottom-sheet
// pattern, never both hidden behind CSS, so the boundary they read must match the one their layout
// itself switches on. Distinct from src/hooks/use-mobile's 768px chrome breakpoint, and from
// Compare's own use-is-compare-desktop.ts (768px: two peer documents fit two-up sooner than a
// document+findings split does) — neither shares this hook's threshold, so neither shares this hook.
const QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

// The server has no viewport; rendering the desktop shape there and correcting on hydration (rather
// than guessing phone) matches src/hooks/use-mobile's own convention for this codebase.
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
