// The one base `test`/`expect` every e2e spec imports instead of "@playwright/test" directly —
// this is what makes the non-localhost abort, the per-context IP and the theme init script apply
// everywhere without every spec file having to opt in by hand. A static guard
// (no-raw-playwright.spec.ts) enforces that every other spec file imports only from here.

import { randomInt } from "node:crypto";
import { test as base, expect } from "@playwright/test";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function isLocalUrl(rawUrl: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

// A fresh random address per context (not derived from worker/parallel index): two contexts in the
// same worker — sequential tests, or a spec that opens more than one context itself — must never be
// able to collide on the same per-IP rate-limit bucket just because they share a worker.
function randomTestIp(): string {
  return `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
}

async function installNonLoopbackAbort(context: BrowserContext): Promise<{ assertClean(): void }> {
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
  return {
    assertClean: () =>
      expect(violations, "a request reached a non-loopback host — every host but 127.0.0.1/localhost must be aborted").toEqual([]),
  };
}

export type ThemeOption = "light" | "dark";

interface Fixtures {
  /** Set per project (desktop-light/desktop-dark/phone-light/phone-dark); read by the page fixture below. */
  theme: ThemeOption;
  /**
   * The x-forwarded-for value this test's default context/request traffic carries — a fresh random
   * address per test, so unrelated specs (and unrelated tests sharing a worker) never share a
   * per-IP rate-limit bucket. A spec that opens additional contexts of its own must use
   * newIsolatedContext() below, which mints its own fresh IP the same way.
   */
  ip: string;
}

export const test = base.extend<Fixtures>({
  theme: ["light", { option: true }],

  ip: [
    // Playwright calls this fixture's second argument positionally, but its literal name "use"
    // trips the repo's react-hooks lint rule (it reads any call shaped like `use(...)` as the React
    // API) — named `provide` throughout this file for that reason alone, not a behavioural change.
    async ({}, provide) => {
      await provide(randomTestIp());
    },
    { option: true },
  ],

  // Overriding this built-in option fixture, rather than passing extraHTTPHeaders in each test,
  // is what makes both `page`/`context`-issued and `request`-fixture traffic carry the same IP.
  extraHTTPHeaders: async ({ ip }, provide) => {
    await provide({ "x-forwarded-for": ip });
  },

  // Aborts and records every request whose host isn't 127.0.0.1/localhost, then fails the test if
  // any were recorded — the request is stopped either way; this only decides whether the test also
  // reports the violation. Playwright's `request` fixture (a bare APIRequestContext, no browser
  // network layer) is never routed through this — nothing here reaches a non-local host in the
  // first place, since every API spec only ever targets the e2e server itself.
  context: async ({ context }, provide) => {
    const guard = await installNonLoopbackAbort(context);
    await provide(context);
    guard.assertClean();
  },

  page: async ({ page, theme }, provide) => {
    // Before any navigation: next-themes reads this on first paint, so the theme must already be in
    // storage by the time the page's own scripts run, not set afterward by a toggle click.
    await page.addInitScript((value: string) => window.localStorage.setItem("theme", value), theme);
    await provide(page);
  },
});

export { expect };

/** One extra, isolated browser context: its own random IP, and the same non-loopback abort as the default context. */
export interface IsolatedContext {
  context: BrowserContext;
  ip: string;
  /** Closes the context, then asserts it never reached a non-loopback host — call this even on a failing path. */
  close(): Promise<void>;
}

/**
 * The only sanctioned way a spec opens an ADDITIONAL browser context (beyond the `context`/`page`
 * fixtures above): a bare `browser.newContext()` gets neither the per-context IP nor the
 * non-loopback abort, and tests/e2e/support/no-raw-playwright.spec.ts's static scan fails the run
 * on any spec file that calls it directly.
 */
export async function newIsolatedContext(browser: Browser, options: BrowserContextOptions = {}): Promise<IsolatedContext> {
  const ip = randomTestIp();
  const context = await browser.newContext({ ...options, extraHTTPHeaders: { ...options.extraHTTPHeaders, "x-forwarded-for": ip } });
  const guard = await installNonLoopbackAbort(context);
  return {
    context,
    ip,
    close: async () => {
      await context.close();
      guard.assertClean();
    },
  };
}

/**
 * Confirms `html.dark` is present or absent before any themed assertion runs — never assumes the
 * init script alone settled it, since next-themes applies the class after hydration, not on the
 * very first paint.
 */
export async function assertThemeApplied(page: Page, theme: ThemeOption): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")), {
      message: `expected html.dark to be ${theme === "dark" ? "present" : "absent"}`,
    })
    .toBe(theme === "dark");
}
