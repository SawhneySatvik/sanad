// The App shell & sidebar's own done-when gates. Uses /settings as the anchor route: it needs no
// document or chat state of its own, and AppShell's chrome is identical on every (app) route, so
// every sidebar-level assertion here is exactly as valid from /settings as from any other route.

import { randomInt } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, assertThemeApplied, type ThemeOption } from "../support/fixtures";

// next dev's own overlay renders a real custom element axe would otherwise scan — next.config.ts is
// a shared root file, so excluding the selector per call is the fix here.
// No standalone Page-typed helper here: the framework's own test package is only ever imported
// through fixtures.ts in this tree (a static guard enforces it, including a type-only import) —
// every axe/live-region call below is inlined so each page argument stays inferred from its own
// test callback.
const AXE_OPTIONS = { exclude: "nextjs-portal" } as const;
const LIVE_REGION_SELECTOR = '[aria-live], [role="alert"], [role="status"], [role="log"]';

/** Leaves /api/documents real (the cross-tab gates need an actual row to prove propagation with),
 * stubbing only the other three list reads. */
async function stubEmptyListsExceptDocuments(page: import("@playwright/test").Page): Promise<void> {
  for (const path of ["comparisons", "drafts", "threads"]) {
    await page.route(`**/api/${path}`, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({ json: { items: [], nextCursor: null } });
    });
  }
}

/** A fresh, distinct x-forwarded-for per page — the e2e server's per-IP budget is deliberately
 * tight (tuned for the IP-isolation spec, which wants to exhaust it in a handful of requests) and
 * shared across every route on that IP. The cross-tab gates need several real round trips across
 * two pages, so each page gets its own header override here, while cookies, localStorage and
 * BroadcastChannel stay shared because pageA/pageB still share one browser context — only the
 * header used for rate-limit accounting differs per page. */
async function givePageOwnIp(page: import("@playwright/test").Page): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}` });
}

/** Below 768px the sidebar's whole content — Recents, the account row, Settings — is a closed
 * Radix Dialog (the phone drawer) and isn't in the DOM at all until opened; every gate below that
 * reads sidebar content needs this first, on phone projects only. */
async function openMobileMenuIfPhone(page: import("@playwright/test").Page, isPhone: boolean): Promise<void> {
  if (isPhone) await page.getByRole("button", { name: "Open menu" }).click();
}

test.describe("App shell & sidebar", () => {
  test("f8-style rename on a RecentsList row updates the row without a full-page reload", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const thread = { id: "local-e2e-rename", title: "Old title", documentIds: [], messages: [] };
      window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-e2e-rename"]));
      window.localStorage.setItem("saboot:threads:v1:local-e2e-rename", JSON.stringify(thread));
    });
    await page.goto("/settings");
    await openMobileMenuIfPhone(page, testInfo.project.name.startsWith("phone"));
    await expect(page.getByText("Old title")).toBeVisible();

    // A marker only a real navigation/reload would wipe (an in-memory global, never persisted).
    await page.evaluate(() => {
      (window as unknown as { __shellTestMarker: boolean }).__shellTestMarker = true;
    });

    await page.getByRole("button", { name: "Actions for Old title" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const field = page.getByLabel("Name", { exact: true });
    await field.fill("New title");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("New title")).toBeVisible();
    await expect(page.getByText("Old title")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __shellTestMarker?: boolean }).__shellTestMarker)).toBe(
      true,
    );
  });

  test("f8-style delete on a local thread row removes it without a full-page reload, and never calls the API", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const thread = { id: "local-e2e-delete", title: "Doomed thread", documentIds: [], messages: [] };
      window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-e2e-delete"]));
      window.localStorage.setItem("saboot:threads:v1:local-e2e-delete", JSON.stringify(thread));
    });
    await page.goto("/settings");
    await openMobileMenuIfPhone(page, testInfo.project.name.startsWith("phone"));
    await expect(page.getByText("Doomed thread")).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __shellTestMarker: boolean }).__shellTestMarker = true;
    });

    let deleteCalled = false;
    await page.route("**/api/threads/**", (route) => {
      if (route.request().method() === "DELETE") deleteCalled = true;
      return route.continue();
    });

    await page.getByRole("button", { name: "Actions for Doomed thread" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("Doomed thread")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __shellTestMarker?: boolean }).__shellTestMarker)).toBe(
      true,
    );
    expect(deleteCalled).toBe(false);
    expect(JSON.parse((await page.evaluate(() => window.localStorage.getItem("saboot:threads:v1:index"))) ?? "[]")).toEqual(
      [],
    );
  });

  test("a guest with 3 local threads, one document and one comparison sees exactly 5 RecentsList rows", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/documents", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        json: {
          items: [
            {
              id: "doc-e2e-1", title: "Lease.pdf", filename: "lease.pdf", documentType: "leave_and_license",
              processingStatus: "ready", analysisState: "complete", inputMode: "text", sampleId: null,
              projectId: null, uploadedAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z",
              expiresAt: null,
            },
          ],
          nextCursor: null,
        },
      });
    });
    await page.route("**/api/comparisons", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        json: {
          items: [
            {
              id: "cmp-e2e-1", title: "Lease v2 comparison", titleA: "A", titleB: "B", documentAId: "a", documentBId: "b",
              modelUsed: "gemini", projectId: null, createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-06-02T00:00:00.000Z", expiresAt: null,
            },
          ],
          nextCursor: null,
        },
      });
    });
    await page.addInitScript(() => {
      const ids = ["local-a", "local-b", "local-c"];
      window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(ids));
      for (const id of ids) {
        window.localStorage.setItem(
          `saboot:threads:v1:${id}`,
          JSON.stringify({ id, title: `Thread ${id}`, documentIds: [], messages: [] }),
        );
      }
    });

    await page.goto("/settings");
    await openMobileMenuIfPhone(page, testInfo.project.name.startsWith("phone"));

    await expect(page.getByRole("link", { name: "Lease.pdf" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Lease v2 comparison" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Thread local-a" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Thread local-b" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Thread local-c" })).toBeVisible();

    const recentsGroup = page.locator('[data-sidebar="group"]', { has: page.locator('[data-sidebar="group-label"]', { hasText: "Recents" }) });
    await expect(recentsGroup.locator('[data-sidebar="menu-item"]')).toHaveCount(5);
  });

  test("live-region allow-list: the set of live nodes is exactly LiveRegion's two nodes plus sonner's toaster section", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const nodes = await page.evaluate(
      (selector) =>
        Array.from(document.querySelectorAll(selector)).map((node) => ({
          ariaLive: node.getAttribute("aria-live"),
          isToasterSection: node.getAttribute("aria-label") === "Notifications alt+T",
          srOnly: node.classList.contains("sr-only"),
        })),
      LIVE_REGION_SELECTOR,
    );
    expect(nodes).toHaveLength(3);
    expect(nodes.filter((n) => n.srOnly && n.ariaLive === "polite")).toHaveLength(1);
    expect(nodes.filter((n) => n.srOnly && n.ariaLive === "assertive")).toHaveLength(1);
    expect(nodes.filter((n) => n.isToasterSection)).toHaveLength(1);
  });

  test("live-region allow-list still holds with the offline banner visible", async ({ page, context }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await context.setOffline(true);
    await expect(page.getByRole("note").filter({ hasText: "You're offline. Saboot needs a connection to read and answer." })).toBeVisible();

    const nodes = await page.evaluate(
      (selector) => Array.from(document.querySelectorAll(selector)).length,
      LIVE_REGION_SELECTOR,
    );
    expect(nodes).toBe(3);
    await context.setOffline(false);
  });

  test("live-region allow-list still holds with the session-failure notice visible", async ({ page }, testInfo) => {
    await page.route("**/api/session", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } } }),
    );
    await page.goto("/settings");
    await openMobileMenuIfPhone(page, testInfo.project.name.startsWith("phone"));
    // Not scoped to exactly one: Settings' own Data section (and, on phone, the top-bar slot) show
    // this same canonical sentence too once the session fetch fails — this gate only cares that at
    // least one copy is visible and the live-region count still holds regardless of how many.
    await expect(page.getByRole("note").filter({ hasText: "We couldn't check your session, so some features are hidden." }).first()).toBeVisible();

    const nodes = await page.evaluate(
      (selector) => Array.from(document.querySelectorAll(selector)).length,
      LIVE_REGION_SELECTOR,
    );
    expect(nodes).toBe(3);
  });

  test("session.failure-hides-signed-in-affordances", async ({ page }, testInfo) => {
    await page.route("**/api/session", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } } }),
    );
    await page.goto("/settings");
    await openMobileMenuIfPhone(page, testInfo.project.name.startsWith("phone"));

    // Settings' own Data section (and, on phone, the top-bar slot) carry the identical sentence
    // too — every copy shares the one session.refetch() handler, so clicking any of them recovers
    // the same way; `.first()` sidesteps the strict-mode multi-match rather than picking a "correct" one.
    await expect(page.getByRole("note").filter({ hasText: "We couldn't check your session, so some features are hidden." }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByText("Sign out", { exact: true })).toHaveCount(0);

    await page.unroute("**/api/session");
    await page.route("**/api/session", (route) =>
      route.fulfill({ json: { kind: "guest", signInAvailable: true, guestTtlHours: 3 } }),
    );
    await page.getByRole("button", { name: "Try again" }).first().click();

    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    // Not a text search: the live region keeps the last-announced message around by design (an
    // announcement is never retracted) — the notice's own role="note" element is the real signal.
    await expect(
      page.getByRole("note").filter({ hasText: "We couldn't check your session, so some features are hidden." }),
    ).toHaveCount(0);
  });

  test("session.cross-tab-broadcast-clears-cache: sign-out on one page propagates to a second page without a reload", async ({
    context,
  }, testInfo) => {
    const isPhone = testInfo.project.name.startsWith("phone");
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await stubEmptyListsExceptDocuments(pageA);
    await stubEmptyListsExceptDocuments(pageB);
    await givePageOwnIp(pageA);
    await givePageOwnIp(pageB);

    // Signs in via the real API directly (page.request shares pageA's cookie jar) rather than
    // through the /sign-in form's own client-side redirect, then seeds one real document (the
    // deterministic sample-open path, no LLM call) — a guest's document list survives sign-in via
    // claim, so there's a real cross-principal row to prove actually clears, not an
    // already-empty list that would pass by coincidence.
    await pageA.request.post("/api/auth/dev-sign-in", { data: { displayName: `Cross Tab User A${randomInt(1_000_000)}` } });
    await pageA.request.post("/api/auth/claim");
    const opened = await pageA.request.post("/api/samples/lease/open");
    expect(opened.ok(), await opened.text()).toBe(true);

    await pageA.goto("/settings");
    await openMobileMenuIfPhone(pageA, isPhone);
    await expect(pageA.getByText("Sign out", { exact: true })).toBeVisible();
    const recentsA = pageA.locator('[data-sidebar="group"]', { has: pageA.locator('[data-sidebar="group-label"]', { hasText: "Recents" }) });
    await expect(recentsA.locator('[data-sidebar="menu-item"]')).toHaveCount(1);

    await pageB.goto("/settings");
    await openMobileMenuIfPhone(pageB, isPhone);
    await expect(pageB.getByText("Sign out", { exact: true })).toBeVisible();
    const recentsB = pageB.locator('[data-sidebar="group"]', { has: pageB.locator('[data-sidebar="group-label"]', { hasText: "Recents" }) });
    await expect(recentsB.locator('[data-sidebar="menu-item"]')).toHaveCount(1);

    await pageA.getByText("Sign out", { exact: true }).click();
    // Unlike Page B below, pageA's own sign-out handler closes the mobile drawer itself once it
    // finishes (the same "close after an action completes" behaviour nav links use) — a closed
    // Sheet unmounts its content entirely, so the "Sign in" link that just took Sign out's place is
    // briefly gone from the DOM until the drawer is reopened here.
    if (isPhone) await pageA.getByRole("button", { name: "Open menu" }).click();
    await expect(pageA.getByRole("link", { name: "Sign in" })).toBeVisible({ timeout: 10_000 });
    await expect(pageA.getByText("Nothing here yet")).toBeVisible();

    // Page B never reloads or is clicked — the broadcast alone must flip its underlying state.
    // Its drawer (opened above for the "before" check, on phone) never closed, so it's already
    // showing the live state; AppShell's own broadcast listener is mounted outside the drawer
    // regardless.
    await expect(pageB.getByRole("link", { name: "Sign in" })).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByText("Sign out", { exact: true })).toHaveCount(0);
    await expect(pageB.getByText("Nothing here yet")).toBeVisible();

    await pageA.close();
    await pageB.close();
  });

  test("session.cross-tab-broadcast-clears-cache: DELETE /api/me/data on one page propagates to a second page", async ({
    context,
  }, testInfo) => {
    // The default 30s budget is tight once /chat's own toHaveURL wait (below) is given the room a
    // dev-server first-compile genuinely needs; the warm-up request above keeps this from actually
    // being spent in the common case.
    test.setTimeout(45_000);
    const isPhone = testInfo.project.name.startsWith("phone");
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await stubEmptyListsExceptDocuments(pageA);
    await stubEmptyListsExceptDocuments(pageB);
    await givePageOwnIp(pageA);
    await givePageOwnIp(pageB);

    // This test is the only one in the file that navigates to /chat — a route with no page of its
    // own yet, so every hit renders the root not-found boundary. Under the dev server's on-demand
    // compilation, the *first* request for any not-yet-compiled route can itself take several
    // seconds; warming it here keeps that cost off the timed assertion below.
    await pageA.request.get("/chat").catch(() => undefined);

    await pageA.request.post("/api/auth/dev-sign-in", { data: { displayName: `Cross Tab User B${randomInt(1_000_000)}` } });
    await pageA.request.post("/api/auth/claim");
    const opened = await pageA.request.post("/api/samples/lease/open");
    expect(opened.ok(), await opened.text()).toBe(true);

    await pageA.goto("/settings");
    await openMobileMenuIfPhone(pageA, isPhone);
    await expect(pageA.getByText("Sign out", { exact: true })).toBeVisible();
    const recentsA = pageA.locator('[data-sidebar="group"]', { has: pageA.locator('[data-sidebar="group-label"]', { hasText: "Recents" }) });
    await expect(recentsA.locator('[data-sidebar="menu-item"]')).toHaveCount(1);

    await pageB.goto("/settings");
    await openMobileMenuIfPhone(pageB, isPhone);
    await expect(pageB.getByText("Sign out", { exact: true })).toBeVisible();
    const recentsB = pageB.locator('[data-sidebar="group"]', { has: pageB.locator('[data-sidebar="group-label"]', { hasText: "Recents" }) });
    await expect(recentsB.locator('[data-sidebar="menu-item"]')).toHaveCount(1);

    // A fresh IP for the remaining sequence: resetQueries() refetches every active query (both
    // documents and session, on both pages) rather than session alone, so the delete-and-propagate
    // step below needs more of the shared per-IP budget than the setup above already spent.
    await givePageOwnIp(pageA);
    await givePageOwnIp(pageB);

    // Delete all my data lives in the main content column, which the still-open drawer's scrim
    // covers on phone — close it before clicking there, the drawer having already served its
    // purpose in the "before" check above.
    if (isPhone) await pageA.keyboard.press("Escape");
    await pageA.getByRole("button", { name: "Delete all my data" }).click();
    // Scoped to the dialog, not `.last()`: `.last()` only happens to be correct once React's
    // synchronous state update has already inserted the dialog's own copy of this button ahead of
    // the page's — scoping to the alertdialog auto-waits for it to exist instead of depending on
    // that ordering.
    await pageA.getByRole("alertdialog").getByRole("button", { name: "Delete all my data" }).click();
    // "Delete all my data" removes an account's DATA, not its own sign-in — a signed-in dev user
    // stays signed in afterward (DELETE /api/me/data never clears the user-session cookie, only
    // the guest one), so the propagated change to prove here is the emptied Recents list, not a
    // sign-out.
    await expect(pageA).toHaveURL(/\/chat$/, { timeout: 20_000 });
    // /chat is a fresh page mount, and under real load its hydration can lag the URL change — a
    // click that lands before the "Open
    // menu" button's handler is attached is a silent no-op, never opening the drawer. Waiting for
    // the network to settle first is the same proxy this file already uses elsewhere for "hydration
    // has caught up."
    await pageA.waitForLoadState("networkidle");
    if (isPhone) await pageA.getByRole("button", { name: "Open menu" }).click();
    await expect(pageA.getByText("Sign out", { exact: true })).toBeVisible();
    await expect(pageA.getByText("Nothing here yet")).toBeVisible();

    // Page B: same reasoning as the sign-out variant above — its drawer, opened in the "before"
    // check and never closed, already reflects whatever AppShell's own broadcast listener reset
    // outside of it, so reopening here would only hit an already-open drawer's own scrim.
    await expect(pageB.getByText("Sign out", { exact: true })).toBeVisible();
    await expect(pageB.getByText("Nothing here yet")).toBeVisible({ timeout: 10_000 });

    await pageA.close();
    await pageB.close();
  });

  test("sidebar collapse persists across a reload but never appears in the server-rendered HTML before hydration", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("phone"), "the icon-rail collapse is a desktop-only affordance — phone has the drawer instead");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute("data-state", "collapsed");
    expect(await page.evaluate(() => window.localStorage.getItem("saboot:sidebar-collapsed:v1"))).toBe("true");

    let documentBody = "";
    page.on("response", async (response) => {
      if (response.url().endsWith("/settings") && response.request().resourceType() === "document") {
        documentBody = await response.text().catch(() => "");
      }
    });
    await page.reload();

    // The raw served markup always renders expanded — the server has no viewer to read
    // localStorage for — and only the post-hydration client flips it to collapsed.
    expect(documentBody).not.toContain('data-state="collapsed"');
    await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute("data-state", "collapsed");
  });

  test("layout: /settings' content wrapper scrolls on overflow while the document itself never does", async ({ page }) => {
    await page.goto("/settings");

    // A real overflow to prove the contract against, not however tall Settings' own two sections
    // happen to be today. flex-shrink: 0 — the wrapper is itself a flex column, and without it the
    // probe is just another flex item the browser shrinks to fit rather than a genuine overflow.
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.setAttribute("data-testid", "layout-probe");
      probe.style.height = "3000px";
      probe.style.flexShrink = "0";
      document.querySelector('[data-slot="app-shell-content"]')?.appendChild(probe);
    });

    const docScrollable = await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc !== null && doc.scrollHeight > doc.clientHeight + 1;
    });
    expect(docScrollable).toBe(false);

    const wrapperMovedOnScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-slot="app-shell-content"]') as HTMLElement | null;
      if (!el) return false;
      el.scrollTop = 500;
      return el.scrollTop > 0;
    });
    expect(wrapperMovedOnScroll).toBe(true);

    // The document itself still hasn't moved — the scroll above landed on the wrapper, not some
    // page-level fallback the h-svh/overflow-hidden main would otherwise still allow.
    const docScrollTop = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
    expect(docScrollTop).toBe(0);
  });

  test("axe: sidebar expanded — zero serious/critical", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: sidebar collapsed — zero serious/critical", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("phone"), "the icon-rail collapse is a desktop-only affordance — phone has the drawer instead");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute("data-state", "collapsed");
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: offline banner visible — zero serious/critical", async ({ page, context }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await context.setOffline(true);
    await expect(page.getByRole("note").filter({ hasText: "You're offline. Saboot needs a connection to read and answer." })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    await context.setOffline(false);
  });

  test("phone drawer: opens via the top-bar menu button, closes on Esc, and passes axe", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("desktop"), "the phone drawer is a phone-only affordance");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("not-found: no art placeholder, states the page doesn't exist (D1)", async ({ page }) => {
    await page.goto("/this-route-will-never-exist");
    await expect(page.getByText(/Placeholder — final art pending/)).toHaveCount(0);
    await expect(page.getByText("This page doesn't exist, or it was deleted.")).toBeVisible();
  });

  test("touch targets at 390px: a sample of controls has a real hit area of at least 44x44, whether via CSS sizing or a pointer-coarse pseudo hit area", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("desktop"), "the 44px touch floor only binds on a touch surface");
    await page.goto("/settings");

    // 1. A control sized 44px for real (h-11/size-11 in CSS) — boundingBox() alone proves this one.
    const openMenuBox = await page.getByRole("button", { name: "Open menu" }).boundingBox();
    expect(openMenuBox).not.toBeNull();
    expect(openMenuBox!.width).toBeGreaterThanOrEqual(44);
    expect(openMenuBox!.height).toBeGreaterThanOrEqual(44);

    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const chatRowBox = await page.getByRole("link", { name: "Chat", exact: true }).boundingBox();
    expect(chatRowBox).not.toBeNull();
    expect(chatRowBox!.height).toBeGreaterThanOrEqual(44);

    // 2. A control that stays visually small (size="sm") and grows its hit area only via the
    // pointer-coarse `::before` pseudo — boundingBox() would report the small visual box, so this
    // one has to be probed by what a real tap actually hits instead.
    await page.unroute("**/api/session").catch(() => undefined);
    await page.route("**/api/session", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } } }),
    );
    await page.reload();
    await page.getByRole("button", { name: "Open menu" }).click();
    // Scoped to the open drawer specifically: the drawer's own scrim sits above the main-content
    // copies of this same notice while open, so probing one of those instead would have
    // elementFromPoint hit the scrim, not the control — this is the one copy real touch input
    // could actually reach right now.
    const tryAgain = page.getByRole("dialog").getByRole("button", { name: "Try again" });
    await expect(tryAgain).toBeVisible();
    const box = await tryAgain.boundingBox();
    expect(box).not.toBeNull();

    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [21, 0],
      [-21, 0],
      [0, 21],
      [0, -21],
    ];
    const handle = await tryAgain.elementHandle();
    for (const [dx, dy] of offsets) {
      const inside = await page.evaluate(
        ({ x, y, el }) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && el !== null && (hit === el || el.contains(hit));
        },
        { x: cx + dx, y: cy + dy, el: handle },
      );
      expect(inside, `elementFromPoint(${cx + dx}, ${cy + dy}) missed the "Try again" hit area`).toBe(true);
    }
  });
});

test.describe("theme convention", () => {
  test("html.dark reflects the configured theme before any themed assertion", async ({ page, theme }) => {
    await page.goto("/settings");
    await assertThemeApplied(page, theme as ThemeOption);
  });
});
