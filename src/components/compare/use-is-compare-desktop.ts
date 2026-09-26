"use client";

import { useSyncExternalStore } from "react";

// Compare's own breakpoint: phone is "<768px", not the analysis workspace's 1024px split-pane
// threshold — two peer documents fit two-up sooner than a document+findings split does.
const QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

// The server has no viewport; rendering the desktop shape there and correcting on hydration
// matches src/hooks/use-mobile and use-is-desktop.ts's own convention.
export function useIsCompareDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
