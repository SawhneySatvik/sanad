// The Prepare screen's own done-when coverage: open the recorded `lease` sample (no live model call
// for Understand), then a real, fake-provider-scripted POST …/prepare call for the lawyer-prep
// output itself — Prepare on a sample is always a live call, there is no replay mechanism for it.

import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";

const AXE_EXCLUDE = "nextjs-portal";

// prepare.ts's own STAGE_GUIDANCE text, confirmed against the real prompt source — one substring
// per lens stage, so a single script answers every document type's "about to sign" lens and another
// answers every "already signed" one, regardless of which document opened it.
const ABOUT_TO_SIGN_MATCH = "This reader has not signed yet";
const ALREADY_SIGNED_MATCH = "This reader has already signed and is bound";

async function openLeaseSample(page: import("@playwright/test").Page): Promise<string> {
  const opened = await page.request.post("/api/samples/lease/open");
  expect(opened.ok(), await opened.text()).toBe(true);
  const body = (await opened.json()) as { documentId: string };
  return body.documentId;
}

// findingIds: ["F1"] — the lease sample always has at least one eligible finding, so its first
// per-call alias always exists, regardless of exactly which real finding it names.
async function registerPrepareScripts(): Promise<void> {
  await registerScript({
    id: `prepare-about-to-sign-${Date.now()}`,
    match: ABOUT_TO_SIGN_MATCH,
    chunks: [
      JSON.stringify({
        lawyerQuestions: [{ question: "What is the notice period before signing?", whyItMatters: "It affects how quickly you can leave.", findingIds: ["F1"] }],
        checklist: [{ item: "Confirm the notice period with the landlord before signing.", findingIds: ["F1"] }],
      }),
    ],
  });
  await registerScript({
    id: `prepare-already-signed-${Date.now()}`,
    match: ALREADY_SIGNED_MATCH,
    chunks: [
      JSON.stringify({
        lawyerQuestions: [{ question: "What is my notice period now that I have signed?", whyItMatters: "It affects your rights going forward.", findingIds: ["F1"] }],
        checklist: [{ item: "Gather proof of the notice period you already agreed to.", findingIds: ["F1"] }],
      }),
    ],
  });
}

test.describe("prepare.complete-renders-both-lists-and-lens-switch-calls-the-model", () => {
  test("open sample -> Prepare -> questions render -> lens toggle -> export copy", async ({ page, context }) => {
    await registerPrepareScripts();
    const documentId = await openLeaseSample(page);

    let prepareRequestCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/prepare")) prepareRequestCount += 1;
    });

    await page.goto(`/documents/${documentId}/prepare`);

    await expect(page.getByRole("heading", { level: 1, name: "Prepared for: Tenant, before signing" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Questions to ask your lawyer" })).toBeVisible();
    await expect(page.getByText("What is the notice period before signing?")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Before you sign / before you meet your lawyer" })).toBeVisible();
    await expect(page.getByText("Confirm the notice period with the landlord before signing.")).toBeVisible();
    await expect(page.locator('[data-slot="verification-badge"]').first()).toBeVisible();
    expect(prepareRequestCount).toBe(1);

    // Lens toggle — a real navigation to a new ?lens=, so a fresh POST fires with the new lens and
    // the previous result's cards are replaced, not merged.
    await page.getByRole("combobox", { name: "Viewing as" }).click();
    await page.getByRole("option", { name: "Tenant, already signed" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Prepared for: Tenant, already signed" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("What is my notice period now that I have signed?")).toBeVisible();
    await expect(page.getByText("What is the notice period before signing?")).toHaveCount(0);
    expect(prepareRequestCount).toBe(2);

    // Export — Copy is plain text, never the escaped Markdown the Download action would produce.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "Copy" }).click();
    await expect(page.getByText("Copied")).toBeVisible();
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("What is my notice period now that I have signed?");
    expect(clipboardText).toContain("Prepared for: Tenant, already signed");
  });
});

test.describe("prepare.not-analyzed-makes-zero-prepare-requests", () => {
  test("a not-analyzed document renders its own EmptyState and never calls POST …/prepare", async ({ page }) => {
    await page.route("**/api/documents/doc-not-analyzed", (route) =>
      route.fulfill({
        json: {
          analysisState: "not_analyzed",
          document: {
            id: "doc-not-analyzed",
            title: "Lease.pdf",
            sampleId: null,
            projectId: null,
            filename: "lease.pdf",
            mimeType: "application/pdf",
            processingStatus: "ready",
            inputMode: "text",
            documentType: null,
            jurisdiction: "IN",
            detectionConfidence: null,
            uploadedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: null,
          },
          analysis: null,
          findings: null,
        },
      }),
    );
    // Counts only the API call, never the page navigation itself (whose own URL also ends in
    // "/prepare").
    let prepareRequestCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/documents/") && request.url().includes("/prepare")) prepareRequestCount += 1;
    });

    await page.goto("/documents/doc-not-analyzed/prepare");
    await expect(page.getByText("This document hasn't been analysed yet.")).toBeVisible();
    expect(prepareRequestCount).toBe(0);
  });
});

test.describe("accessibility", () => {
  test("axe: prepare complete state — zero serious/critical", async ({ page }) => {
    await registerPrepareScripts();
    const documentId = await openLeaseSample(page);
    await page.goto(`/documents/${documentId}/prepare`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    const results = await new AxeBuilder({ page }).exclude(AXE_EXCLUDE).analyze();
    expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  });
});
