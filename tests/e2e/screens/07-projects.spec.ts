// /projects' own done-when gates.

import { randomInt } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, assertThemeApplied, type ThemeOption } from "../support/fixtures";

const AXE_OPTIONS = { exclude: "nextjs-portal" } as const;

async function devSignIn(page: import("@playwright/test").Page, displayName: string) {
  await page.request.post("/api/auth/dev-sign-in", { data: { displayName } });
  await page.request.post("/api/auth/claim");
}

test.describe("/projects — signInAvailable x principal matrix", () => {
  test("projects.production-mode-shows-notice-not-empty-state", async ({ page }) => {
    await page.route("**/api/session", (route) => route.fulfill({ json: { kind: "guest", signInAvailable: false, guestTtlHours: 3 } }));
    await page.goto("/projects");
    // getByRole("note").filter(...), not a bare getByText: InlineNotice's own useAnnounceOnMount
    // copies this exact text into the sr-only polite LiveRegion too.
    await expect(page.getByRole("note").filter({ hasText: "Projects need an account, and account sign-in isn't turned on for this build yet." })).toBeVisible();
    await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
    await expect(page.locator('[data-slot="card"]')).toHaveCount(0);
  });

  test("projects.guest-new-project-nudges-not-creates", async ({ page }) => {
    let createCalled = false;
    await page.route("**/api/projects", (route) => {
      if (route.request().method() === "POST") createCalled = true;
      return route.continue();
    });
    await page.goto("/projects");
    // .first(): the header's own "New project" and EmptyState's own CTA of the same name both
    // render at once whenever the grid is empty — either one calls the identical handler.
    await page.getByRole("button", { name: "New project" }).first().click();
    // .first(): SignInNudge's own useAnnounceOnMount copies this exact text into the sr-only
    // assertive LiveRegion too, so a plain text query resolves to two elements.
    await expect(page.getByText("Sign in to keep this").first()).toBeVisible();
    expect(createCalled).toBe(false);
  });
});

test.describe("/projects — real create/rename/delete", () => {
  test("projects.create-then-rename-then-delete", async ({ page }) => {
    await devSignIn(page, `E2E Projects ${randomInt(1_000_000)}`);
    await page.goto("/projects");

    // .first(): the header's own "New project" and EmptyState's own CTA of the same name both
    // render at once whenever the grid is empty — either one calls the identical handler.
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill("Apartment hunt");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Project created")).toBeVisible();
    await expect(page.getByRole("link", { name: /Apartment hunt/ })).toBeVisible();

    await page.getByRole("button", { name: "Actions for Apartment hunt" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    // exact: true — "Rename project" (the dialog's own accessible name) is a substring match for
    // "Name" too, otherwise ambiguous with the actual field.
    const field = page.getByLabel("Name", { exact: true });
    await field.fill("x".repeat(121));
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await field.fill("New apartment");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("link", { name: /New apartment/ })).toBeVisible();

    await page.getByRole("button", { name: "Actions for New apartment" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("link", { name: /New apartment/ })).toHaveCount(0);
  });

  test("projects.card-stretched-link-no-nested-interactive", async ({ page }) => {
    await devSignIn(page, `E2E Nested ${randomInt(1_000_000)}`);
    await page.goto("/projects");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill("Nested check");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: /Nested check/ })).toBeVisible();

    const nested = await page.evaluate(() => {
      const link = document.querySelector('a[href^="/projects/"]');
      const trigger = Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label")?.startsWith("Actions for Nested check"));
      if (!link || !trigger) return { found: false };
      return { found: true, linkContainsTrigger: link.contains(trigger), triggerContainsLink: trigger.contains(link) };
    });
    expect(nested.found).toBe(true);
    expect(nested.linkContainsTrigger).toBe(false);
    expect(nested.triggerContainsLink).toBe(false);

    // Clicking the ItemMenu trigger opens the menu, never navigates.
    await page.getByRole("button", { name: "Actions for Nested check" }).click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page).toHaveURL("/projects");
    await page.keyboard.press("Escape");

    // Clicking the card body (its title link) navigates.
    await page.getByRole("link", { name: /Nested check/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  });
});

test.describe("theme convention", () => {
  test("html.dark reflects the configured theme before any themed assertion", async ({ page, theme }) => {
    await devSignIn(page, `E2E Theme ${randomInt(1_000_000)}`);
    await page.goto("/projects");
    await assertThemeApplied(page, theme as ThemeOption);
  });
});

test.describe("accessibility", () => {
  test("axe: /projects empty state (signed in) — zero serious/critical", async ({ page }) => {
    await devSignIn(page, `E2E Axe Empty ${randomInt(1_000_000)}`);
    await page.goto("/projects");
    await expect(page.getByText("No projects yet")).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /projects populated grid — zero serious/critical", async ({ page }) => {
    await devSignIn(page, `E2E Axe Grid ${randomInt(1_000_000)}`);
    await page.goto("/projects");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill("Axe check");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: /Axe check/ })).toBeVisible();
    // sonner's own toast fades in over 400ms (opacity 0 -> 1) — scanning mid-fade reads the
    // still-transparent text against the popover background as a false color-contrast violation.
    // Polled on the toast's own computed opacity, not a fixed sleep: a slow run needs longer than
    // 400ms to even reach the fade, and a fixed wait either races that or overshoots on a fast one.
    await expect
      .poll(async () => Number(await page.locator("[data-sonner-toast]").first().evaluate((el) => getComputedStyle(el).opacity)))
      .toBe(1);
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: ProjectDialog open (create mode) — zero serious/critical", async ({ page }) => {
    await devSignIn(page, `E2E Axe Dialog ${randomInt(1_000_000)}`);
    await page.goto("/projects");
    await page.getByRole("button", { name: "New project" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: !signInAvailable InlineNotice — zero serious/critical", async ({ page }) => {
    await page.route("**/api/session", (route) => route.fulfill({ json: { kind: "guest", signInAvailable: false, guestTtlHours: 3 } }));
    await page.goto("/projects");
    // getByRole("note").filter(...), not a bare getByText: InlineNotice's own useAnnounceOnMount
    // copies this exact text into the sr-only polite LiveRegion too — a race the phone project's
    // own slower render made visible even though this substring query only ever intended to be a
    // loose match.
    await expect(page.getByRole("note").filter({ hasText: "Projects need an account" })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: guest SignInNudge visible — zero serious/critical", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "New project" }).first().click();
    await expect(page.getByText("Sign in to keep this").first()).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
