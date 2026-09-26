// The same localStorage-init + assert-html.dark convention tests/e2e/support/fixtures.ts's `page`
// fixture and `assertThemeApplied` use for Playwright specs, reimplemented for this harness's bare
// (non-test-runner) Page use — next-themes applies `.dark` after hydration, not on first paint, so
// a themed screenshot always polls for the class rather than trusting the init script alone.

import type { Page } from "@playwright/test";
import type { ThemeOption } from "./types";

/**
 * Set before navigation: next-themes reads this on first paint. Runs before every document this
 * page ever loads, not only the captured route — including a state's own mid-capture detour (a
 * CSP-free `about:blank` hop before a deliberately non-local fetch, say), where localStorage access
 * can throw a SecurityError on an opaque origin. Priming the theme there was never the point of
 * visiting it, so that failure is swallowed rather than surfaced as an uncaught page error.
 */
export async function primeTheme(page: Page, theme: ThemeOption): Promise<void> {
  await page.addInitScript((value: string) => {
    try {
      window.localStorage.setItem("theme", value);
    } catch {
      // See the function comment above.
    }
  }, theme);
}

export async function waitForThemeApplied(page: Page, theme: ThemeOption, timeoutMs = 10_000): Promise<void> {
  const wantDark = theme === "dark";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    if (isDark === wantDark) return;
    if (Date.now() > deadline) {
      throw new Error(`capture-screens: html.dark never became ${wantDark ? "present" : "absent"} for theme=${theme}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
