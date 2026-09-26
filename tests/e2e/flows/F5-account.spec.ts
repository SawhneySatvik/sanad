// F5's cross-screen walk: dev sign-in (the product's only stand-in for real auth) claims a
// guest's sample document, a new project is created, and the document is saved into it from its own
// workspace menu — the project detail page then lists it. Screen-level detail (cross-tab sync, the
// inline-body-distrust re-fetch, the picker's own popover/sheet split) lives under
// tests/e2e/screens/**; this spec only proves the handoffs and the end state.

import { randomInt } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { isPhoneProject, openLeaseSample } from "./_shared";

test.describe("F5 account", () => {
  test("F5 account: guest sample -> dev sign-in -> claim -> new project -> save to it -> project detail lists it @flow", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const documentId = await openLeaseSample(page);

    const displayName = `E2E F5 ${randomInt(1_000_000)}`;
    await page.goto("/sign-in");
    await page.getByLabel("Name", { exact: true }).fill(displayName);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
    // Not the claim toast: sonner's own fixed dismiss timer starts at mount, not at whatever
    // moment a slow, heavily-loaded run happens to reach this assertion, so a longer wait here
    // doesn't reliably fix a race a toast can lose on its own. The durable proof that claim
    // actually re-owned this document is that the signed-in session can now read it at all.
    const claimedDocument = await page.request.get(`/api/documents/${documentId}`);
    expect(claimedDocument.ok(), await claimedDocument.text()).toBe(true);

    const projectName = `E2E F5 Project ${randomInt(1_000_000)}`;
    await page.goto("/projects");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.getByLabel("Name", { exact: true }).fill(projectName);
    await page.getByRole("button", { name: "Create" }).click();
    // Not the "Project created" toast, for the same reason as the claim toast above: the durable,
    // non-transient proof is the project's own link actually appearing in the list.
    const projectLink = page.getByRole("link", { name: new RegExp(projectName) });
    await expect(projectLink).toBeVisible({ timeout: 10_000 });
    await projectLink.click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/, { timeout: 10_000 });
    const projectId = page.url().split("/projects/")[1];

    await page.goto(`/documents/${documentId}`);
    await page.waitForLoadState("networkidle");
    await page.locator("header").getByRole("button", { name: /^Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Save to project" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: projectName }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Not the "Saved to project" toast, for the same reason as above: the dialog closing only on a
    // genuine success is the durable signal, and the final project-detail check below is the real
    // end-state proof either way.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });

    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState("networkidle");
    if (isPhoneProject(testInfo)) {
      await page.getByRole("button", { name: /^Documents,/ }).click();
    }
    // Scoped to the main landmark: the sidebar's own RecentsList shows this same, now-recent
    // document too, a real, same-name collision, not a test artifact.
    await expect(page.getByRole("main").getByText("leave-and-license-sample.txt")).toBeVisible({ timeout: 10_000 });
  });
});
