// The landing page's own done-when gates: renders above the fold with no data fetch, its CTA
// reaches /chat, and it's clean under axe in both themes.

import AxeBuilder from "@axe-core/playwright";
import { test, expect, assertThemeApplied } from "../support/fixtures";

// next dev's own overlay renders a real custom element axe would otherwise scan.
const AXE_OPTIONS = { exclude: "nextjs-portal" } as const;

test.describe("Landing (/)", () => {
  test("marketing.renders-the-hero", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Read the document. See exactly where it says so." })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test("marketing.cta-navigates-to-chat", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Try a sample" }).click();
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("marketing.axe-clean", async ({ page, theme }) => {
    await page.goto("/");
    await assertThemeApplied(page, theme);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
