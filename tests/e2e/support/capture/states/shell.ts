// The app shell/sidebar screen's own states: the app shell/sidebar chrome (default), the sign-in
// screen, the phone drawer open, the session-failure notice, and the root not-found boundary —
// every state tests/e2e/screens/02-shell*.spec.ts exercises as its own distinct scenario.
//
//   npm run capture:screens -- --screen shell --states default,sign-in,not-found,session-failure,phone-sidebar-open

import type { StateRegistry } from "../types";

const SESSION_FAILURE_RESPONSE = {
  status: 500,
  json: { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } },
} as const;

export const states: StateRegistry = {
  default: { route: "/settings" },

  "sign-in": { route: "/sign-in" },

  // A path that will never become a real route — the root not-found boundary renders for it
  // regardless of what else exists under /app.
  "not-found": { route: "/this-route-will-never-exist", expectStatus: 404 },

  // Same stub tests/e2e/screens/02-shell.spec.ts's own session-failure test uses: /api/session
  // failing is what puts the sidebar into its "some features are hidden" state.
  "session-failure": {
    route: "/settings",
    setup: async ({ page }) => {
      await page.route("**/api/session", (route) => route.fulfill(SESSION_FAILURE_RESPONSE));
    },
  },

  // The drawer only exists on phone; on desktop this state is just "default" again — the sidebar
  // is already on-screen there, nothing to open.
  "phone-sidebar-open": {
    route: "/settings",
    ready: async ({ page }) => {
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      const isPhone = (page.viewportSize()?.width ?? 0) < 768;
      if (isPhone) {
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.getByRole("dialog").waitFor({ state: "visible" });
        // The drawer's own slide + the scrim's fade are still animating once "visible" merely means
        // present in the DOM at non-zero opacity — waiting for every running Web Animation (covers
        // both the scrim's CSS animation and the panel's) is what keeps the shot from landing
        // mid-slide.
        await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      }
    },
  },
};
