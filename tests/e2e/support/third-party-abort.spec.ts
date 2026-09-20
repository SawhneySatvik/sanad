// Deliberately-failing proof spec, per the gate: "a spec requesting a third-party URL fails the
// run." Skipped by default so it never sits in the green `test:e2e` run — the fixtures.ts `context`
// fixture aborts the request either way; this file exists to red-prove that the abort ALSO fails
// the test, not just silently swallows the request. Run explicitly with SABOOT_E2E_PROVE_ABORT=1
// (see this repo's build report for both the skipped and the failing output).

import { test } from "./fixtures";

const PROVE_ABORT = process.env.SABOOT_E2E_PROVE_ABORT === "1";

test.describe("third-party abort (deliberately failing proof)", () => {
  test.skip(!PROVE_ABORT, "Run with SABOOT_E2E_PROVE_ABORT=1 to red-prove the non-loopback abort; skipped otherwise.");

  test("a page fetching a non-loopback host fails the run", async ({ page }) => {
    await page.goto("about:blank");
    // The fixtures.ts context fixture aborts this and records it; its own teardown assertion is
    // what fails the test — nothing here needs to inspect the (rejected) fetch's own outcome.
    await page.evaluate(() => fetch("https://example.com/").catch(() => undefined));
  });
});
