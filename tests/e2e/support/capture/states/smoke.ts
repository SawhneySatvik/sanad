// Registers this file's states for the harness's own smoke gate, not a real screen —
// invoked as `--screen smoke --states default,broken,external`. Exercises the three failure modes
// the harness must catch on its own: a normal page (must pass), a route that doesn't exist (must
// fail the run), and a page that reaches out to a non-local host (must fail the run).

import type { StateRegistry } from "../types";

export const states: StateRegistry = {
  default: { route: "/" },
  // No expectStatus override: the harness's default ("status must be < 400") is what makes this
  // 404 fail the run — that default is the actual thing under test here.
  broken: { route: "/capture-smoke-nonexistent-route" },
  external: {
    route: "/",
    ready: async ({ page }) => {
      // about:blank first: once a page ever sets a Content-Security-Policy connect-src, a fetch
      // from a same-origin document could be blocked by CSP before it ever reaches the network
      // layer this guard patches — that would make this proof state pass for the wrong reason.
      await page.goto("about:blank");
      await page.evaluate(() => fetch("https://example.com/").catch(() => undefined));
    },
  },
};
