// /projects/[id]'s own done-when gates. Setup (dev sign-in, sample open, save-to-project) is
// driven directly over HTTP (page.request), the same convention the capture-state harness uses —
// none of it needs a live model call, so every gate here is a real backend round trip, not a fixture.

import { randomInt } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, newIsolatedContext } from "../support/fixtures";

const AXE_OPTIONS = { exclude: "nextjs-portal" } as const;

// The sample document's own title once opened: findOrInsertSampleDocument never sets a `title`
// (only `filename`), and project-view.ts's documentSummaryView falls back to the filename — never
// the registry's descriptive "Sample: Leave and License Agreement" (that string names the sample
// entry, not the row this flow creates).
const LEASE_SAMPLE_TITLE = "leave-and-license-sample.txt";

async function devSignIn(page: import("@playwright/test").Page, displayName: string) {
  await page.request.post("/api/auth/dev-sign-in", { data: { displayName } });
  await page.request.post("/api/auth/claim");
}

async function openLeaseSample(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.post("/api/samples/lease/open");
  const body = (await res.json()) as { documentId: string };
  return body.documentId;
}

async function createProject(page: import("@playwright/test").Page, name: string): Promise<string> {
  const res = await page.request.post("/api/projects", { data: { name } });
  const body = (await res.json()) as { id: string };
  return body.id;
}

test.describe("/projects/[id] — guest boundary", () => {
  test("project-detail.guest-always-404s", async ({ page, browser }) => {
    await devSignIn(page, `E2E Detail Owner ${randomInt(1_000_000)}`);
    const projectId = await createProject(page, "Owner-only project");

    const guest = await newIsolatedContext(browser);
    const guestPage = await guest.context.newPage();
    await guestPage.goto(`/projects/${projectId}`);
    // .first(): ErrorState's own useAnnounceOnMount copies this exact text into the sr-only
    // assertive LiveRegion too, so a plain text query resolves to two elements.
    await expect(guestPage.getByText("The requested resource could not be found.").first()).toBeVisible();
    await guest.close();
  });
});

test.describe("/projects/[id] — unassign", () => {
  test("project-detail.unassign-keeps-item-removes-from-project", async ({ page }) => {
    await devSignIn(page, `E2E Unassign ${randomInt(1_000_000)}`);
    const documentId = await openLeaseSample(page);
    const projectId = await createProject(page, "Unassign check");
    await page.request.post(`/api/documents/${documentId}/save-to-project`, { data: { projectId } });

    await page.goto(`/projects/${projectId}`);
    // Scoped to #main-content: the sidebar's own RecentsList shows this same now-recent document,
    // with its own identically-named link and "Actions for …" trigger.
    const main = page.locator("#main-content");
    await expect(main.getByRole("link", { name: LEASE_SAMPLE_TITLE, exact: true })).toBeVisible();

    await main.getByRole("button", { name: `Actions for ${LEASE_SAMPLE_TITLE}` }).click();
    await page.getByRole("menuitem", { name: "Remove from project" }).click();
    await expect(page.getByText("It stays in your library.")).toBeVisible();
    await page.getByRole("button", { name: "Remove" }).click();
    // A generous timeout: DELETE /api/documents/:id/project's own on-demand dev-server compile
    // (observed at 3.7s solo, 7.1s alongside this file's own parallel siblings) can push past the
    // default 5s.
    await expect(page.getByText("Removed from project")).toBeVisible({ timeout: 15_000 });
    // Still scoped: unassign never removes it from the library, so the sidebar keeps its own link.
    await expect(main.getByRole("link", { name: LEASE_SAMPLE_TITLE, exact: true })).toHaveCount(0);

    // Still in the library, and unassign never restores a TTL.
    const after = await (await page.request.get(`/api/documents/${documentId}`)).json();
    expect(after.document.expiresAt).toBeNull();
    expect(after.document.projectId).toBeNull();
  });

  test("project-detail.delete-unassigns-not-deletes", async ({ page }) => {
    await devSignIn(page, `E2E Project Delete ${randomInt(1_000_000)}`);
    const documentId = await openLeaseSample(page);
    const projectId = await createProject(page, "Delete-me project");
    await page.request.post(`/api/documents/${documentId}/save-to-project`, { data: { projectId } });

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("button", { name: "Actions for Delete-me project" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page).toHaveURL("/projects");

    const after = await (await page.request.get(`/api/documents/${documentId}`)).json();
    expect(after.document.projectId).toBeNull();
  });
});

test.describe("accessibility", () => {
  test("axe: /projects/[id] populated — zero serious/critical", async ({ page }) => {
    await devSignIn(page, `E2E Detail Axe ${randomInt(1_000_000)}`);
    const documentId = await openLeaseSample(page);
    const projectId = await createProject(page, "Axe check");
    await page.request.post(`/api/documents/${documentId}/save-to-project`, { data: { projectId } });
    await page.goto(`/projects/${projectId}`);
    await expect(page.locator("#main-content").getByRole("link", { name: LEASE_SAMPLE_TITLE, exact: true })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /projects/[id] empty project — zero serious/critical", async ({ page }) => {
    await devSignIn(page, `E2E Detail Empty ${randomInt(1_000_000)}`);
    const projectId = await createProject(page, "Empty project");
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByText("Nothing in this project yet")).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: 'Remove from project' unassign dialog open — zero serious/critical", async ({ page }) => {
    await devSignIn(page, `E2E Detail Unassign Axe ${randomInt(1_000_000)}`);
    const documentId = await openLeaseSample(page);
    const projectId = await createProject(page, "Unassign axe check");
    await page.request.post(`/api/documents/${documentId}/save-to-project`, { data: { projectId } });
    await page.goto(`/projects/${projectId}`);
    // Waited for, then scoped to #main-content: a bare /^Actions for/ also matches the sidebar's
    // own ItemMenu trigger for this same now-recent document (no "Remove from project" entry
    // there), which this click would otherwise open instead, before the detail query even resolves.
    const main = page.locator("#main-content");
    await expect(main.getByRole("link", { name: LEASE_SAMPLE_TITLE, exact: true })).toBeVisible();
    await main.getByRole("button", { name: `Actions for ${LEASE_SAMPLE_TITLE}` }).click();
    await page.getByRole("menuitem", { name: "Remove from project" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: guest-404 state — zero serious/critical", async ({ page, browser }) => {
    await devSignIn(page, `E2E Detail Guest404 ${randomInt(1_000_000)}`);
    const projectId = await createProject(page, "Guest-blocked project");
    const guest = await newIsolatedContext(browser);
    const guestPage = await guest.context.newPage();
    await guestPage.goto(`/projects/${projectId}`);
    await expect(guestPage.getByText("The requested resource could not be found.").first()).toBeVisible();
    const results = await new AxeBuilder({ page: guestPage }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    await guest.close();
  });
});
