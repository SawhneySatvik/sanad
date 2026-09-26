// A capture must never make a live call — the same rule tests/e2e/support/fixtures.ts's `context`
// fixture enforces for Playwright specs, reimplemented here rather than imported: fixtures.ts's
// guard is wired through `test.extend`'s fixture teardown (an `expect` assertion), which only runs
// inside a Playwright test; this harness drives pages from a bare script, so the guard instead
// leaves its findings on a plain array the caller inspects and turns into a thrown error itself.

import type { BrowserContext } from "@playwright/test";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/** Pure: exported for its own unit test. */
export function isLocalUrl(rawUrl: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

export interface NetworkGuard {
  /** Every non-local URL a page under this context tried to reach — the request is aborted either way; this only lets the caller decide whether to fail the run. */
  readonly violations: string[];
}

export async function installNetworkGuard(context: BrowserContext): Promise<NetworkGuard> {
  const violations: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (isLocalUrl(url)) {
      void route.continue();
      return;
    }
    violations.push(url);
    void route.abort();
  });
  return { violations };
}
