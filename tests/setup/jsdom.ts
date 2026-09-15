// Extends, never replaces, tests/setup/no-network.ts — that file is a separate, earlier entry in
// this project's setupFiles, so the network guard is already installed by the time this runs.

import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";
import "@testing-library/jest-dom/vitest";

expect.extend(toHaveNoViolations);

// Without an explicit unmount, RTL leaves every test's rendered tree in the jsdom document —
// the next test's queries and axe run would see accumulated, stale nodes instead of just its own.
afterEach(() => {
  cleanup();
});

// next-themes (system-preference detection) and sonner both call matchMedia on mount; jsdom has
// no implementation of it at all, so an unstubbed call throws before either component renders.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
