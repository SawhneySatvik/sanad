// Drives a headless Chromium against an already-running e2e-mode server: one browser, one fresh
// context per (state x viewport x theme), so no capture can leak state (a cookie, a route mock)
// into the next one. scripts/capture-screens.ts owns bringing that server up and tearing it down;
// this module only knows the base URL it can reach.

import { randomInt } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { resetFakeProvider } from "../fake-provider/client";
import { isThemeIdentical, isTooSmall, MIN_BYTES_BY_VIEWPORT } from "./capture-checks";
import { installNetworkGuard } from "./network-guard";
import { screenshotPath, THEMES, VIEWPORTS, type ViewportName } from "./paths";
import { loadStateRegistry, pickStates } from "./registry";
import { primeTheme, waitForThemeApplied } from "./theme";
import type { CaptureContext, CaptureState, ThemeOption } from "./types";

export interface RunCapturesOptions {
  baseUrl: string;
  screen: string;
  stateNames: string[];
  outDir: string;
}

export interface CaptureResult {
  state: string;
  viewport: ViewportName;
  theme: ThemeOption;
  file: string;
  bytes: number;
}

// Generous: a cold Turbopack route can still be mid-compile despite scripts/capture-screens.ts's
// own pre-warm fetch (its own connection settling doesn't guarantee the compiled module is cached
// yet for the very next request).
const NAV_TIMEOUT_MS = 60_000;

function randomTestIp(): string {
  // Never derived from state/viewport/theme index: two captures sharing a bucket would make a
  // route's own per-IP limiter (not under test here, but still live) flaky across runs.
  return `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
}

function statusOk(status: number, expect: CaptureState["expectStatus"]): boolean {
  if (expect === undefined) return status < 400;
  return typeof expect === "number" ? status === expect : expect(status);
}

async function defaultReady(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Removes exactly the PNGs this run is about to (re)write, so a failed re-capture can never leave
 * a reviewer looking at a previous run's stale images. Named by the exact same screenshotPath() the
 * write path below uses — a prefix match would also delete an unrelated state whose name happens to
 * start with this one's (e.g. "loading" deleting "loading-slow"'s files too).
 */
async function clearExistingCaptures(outDir: string, screen: string, stateNames: string[]): Promise<void> {
  const files = stateNames.flatMap((name) => VIEWPORTS.flatMap((viewport) => THEMES.map((theme) => screenshotPath(outDir, screen, name, viewport.name, theme))));
  await Promise.all(
    files.map((file) =>
      unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
    ),
  );
}

export async function runCaptures(options: RunCapturesOptions): Promise<CaptureResult[]> {
  const registry = await loadStateRegistry(options.screen);
  const selected = pickStates(registry, options.stateNames);

  await clearExistingCaptures(options.outDir, options.screen, options.stateNames);

  const browser = await chromium.launch();
  const results: CaptureResult[] = [];
  try {
    for (const { name, state } of selected) {
      for (const viewport of VIEWPORTS) {
        const shotsByTheme = new Map<ThemeOption, Buffer>();
        for (const theme of THEMES) {
          const label = `${options.screen}/${name} (${viewport.name}/${theme})`;
          const context = await browser.newContext({
            baseURL: options.baseUrl,
            viewport: { width: viewport.width, height: viewport.height },
            isMobile: viewport.isMobile,
            hasTouch: viewport.isMobile,
            colorScheme: theme,
            extraHTTPHeaders: { "x-forwarded-for": randomTestIp() },
          });
          try {
            // Every capture starts from a clean fake provider — see types.ts's header for why:
            // without this, a state that holds a stream (loading) or takes the provider down
            // (error) would leak that into whichever capture runs next, in this state or another.
            await resetFakeProvider();
            const guard = await installNetworkGuard(context);
            const page = await context.newPage();
            page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(String(error)));
            // Never fails the run on its own — a console error is often the same hydration or
            // fetch problem a real user would never see, but a reviewer should still be told about
            // it instead of only ever seeing the screenshot.
            page.on("console", (message) => {
              if (message.type() === "error") console.error(`capture-screens: ${label} — console error: ${message.text()}`);
            });
            await primeTheme(page, theme);

            const ctx: CaptureContext = { page, context, baseUrl: options.baseUrl };
            if (state.setup) await state.setup(ctx);

            const response = await page.goto(state.route, { waitUntil: "load" });
            const status = response?.status();
            if (status === undefined || !statusOk(status, state.expectStatus)) {
              throw new Error(`capture-screens: ${label} — ${state.route} responded ${status ?? "with no response"}`);
            }

            await waitForThemeApplied(page, theme);

            if (state.ready) await state.ready(ctx);
            else await defaultReady(page);

            if (!state.allowPageErrors && pageErrors.length > 0) {
              throw new Error(`capture-screens: ${label} — uncaught page error: ${pageErrors[0]}`);
            }
            if (guard.violations.length > 0) {
              throw new Error(`capture-screens: ${label} — non-local request(s): ${guard.violations.join(", ")}`);
            }

            // Next dev's floating build-activity indicator is real but never part of any user's
            // screen — hidden only after every failure check above, so it can never mask one. A
            // direct style-property write, not page.addStyleTag(): a style-src CSP governs the
            // <style> element addStyleTag() inserts, but not a CSSOM property write like this one.
            await page.evaluate(() => {
              document.querySelectorAll("nextjs-portal").forEach((el) => {
                (el as HTMLElement).style.display = "none";
              });
            });

            const buffer = await page.screenshot({ type: "png" });
            if (guard.violations.length > 0) {
              throw new Error(`capture-screens: ${label} — non-local request(s) during screenshot: ${guard.violations.join(", ")}`);
            }
            const minBytes = MIN_BYTES_BY_VIEWPORT[viewport.name];
            if (isTooSmall(buffer.byteLength, minBytes)) {
              throw new Error(`capture-screens: ${label} — only ${buffer.byteLength} bytes, looks blank (floor ${minBytes})`);
            }

            const file = screenshotPath(options.outDir, options.screen, name, viewport.name, theme);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, buffer);
            shotsByTheme.set(theme, buffer);
            results.push({ state: name, viewport: viewport.name, theme, file, bytes: buffer.byteLength });
          } finally {
            await context.close();
          }
        }
        const light = shotsByTheme.get("light");
        const dark = shotsByTheme.get("dark");
        if (light && dark && isThemeIdentical(light, dark)) {
          throw new Error(
            `capture-screens: ${options.screen}/${name} (${viewport.name}) — light and dark screenshots are byte-identical; the theme likely never applied`,
          );
        }
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}
