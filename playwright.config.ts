import { defineConfig } from "@playwright/test";
import type { ThemeOption } from "./tests/e2e/support/fixtures";

// Desktop 1440 and phone 390, each in light and dark — four projects total. Chromium only (the
// installed browser); the phone projects hand-roll a small viewport plus touch emulation instead of
// devices['iPhone …'], which is WebKit-only and not installed here.
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const PHONE_VIEWPORT = { width: 390, height: 844 };

export default defineConfig<{ theme: ThemeOption }>({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-light",
      use: { browserName: "chromium", viewport: DESKTOP_VIEWPORT, colorScheme: "light", theme: "light" },
    },
    {
      name: "desktop-dark",
      use: { browserName: "chromium", viewport: DESKTOP_VIEWPORT, colorScheme: "dark", theme: "dark" },
    },
    {
      name: "phone-light",
      use: {
        browserName: "chromium",
        viewport: PHONE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        colorScheme: "light",
        theme: "light",
      },
    },
    {
      name: "phone-dark",
      use: {
        browserName: "chromium",
        viewport: PHONE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        colorScheme: "dark",
        theme: "dark",
      },
    },
  ],
  webServer: {
    command: "npm run e2e:server",
    // /api/e2e/ping, not /api/health: it 200s only when SABOOT_E2E=1, so reuseExistingServer can
    // never attach to some other, non-e2e `next dev` a developer happens to have up on this port.
    url: "http://127.0.0.1:3100/api/e2e/ping",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
