// F1's cross-screen walk: the landing page's own CTA hands off to /chat's real SampleCards, which
// hands off to the analysis workspace, where a finding's own "Show in document"/"Test this quote"
// controls are what the evaluator actually touches first. Every screen-level assertion this flow
// touches on the way (category grouping, lens toggle, axe) already has its own gate under
// tests/e2e/screens/**; this spec only proves the handoffs and the end state.

import { test, expect } from "../support/fixtures";
import { isPhoneProject, openFindingsIfPhone } from "./_shared";

test.describe("F1 first visit", () => {
  test("F1 first visit: landing -> try a sample -> workspace -> show in document -> test this quote @flow", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    await page.goto("/");
    await page.getByRole("link", { name: "Try a sample" }).click();
    await expect(page).toHaveURL(/\/chat$/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // The real, recorded lease sample — no fake-provider script needed, unlike every other flow's
    // own document (the sample replay pipeline still runs verify() on the live text).
    await page.getByRole("button", { name: /leave-and-license/ }).click();
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/, { timeout: 20_000 });
    await page.waitForLoadState("networkidle");

    // The handoff's own honesty check: this really is the recorded sample, re-verified live on this
    // very open — not a client-side shortcut around a fresh GET /api/documents/:id.
    await expect(page.getByRole("note").filter({ hasText: "Sample document. Its analysis was recorded earlier" })).toBeVisible({ timeout: 15_000 });

    await openFindingsIfPhone(page, testInfo);
    const card = page.locator("article[data-finding-category]").first();
    await card.getByRole("button", { name: /^Show .+ in document$/ }).click();
    if (isPhoneProject(testInfo)) await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("mark[data-active]")).toBeVisible({ timeout: 10_000 });

    // Test this quote: never mutates the stored finding, and the badge it shows comes only from a
    // real POST /api/verify-batch response — proven at screen level; here only the end state matters.
    await openFindingsIfPhone(page, testInfo);
    await card.getByRole("button", { name: "Test this quote" }).click();
    const field = page.getByLabel("Test this quote");
    await field.fill("The submarine's periscope malfunctioned during the lunar eclipse ceremony.");
    const demoContainer = field.locator("..");
    await expect(demoContainer.getByText("Not found in your document")).toBeVisible({ timeout: 15_000 });
  });
});
