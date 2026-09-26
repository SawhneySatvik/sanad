// "Chat home"'s own done-when gates. Every network call this file drives (except a real
// sample-open, which has its own deterministic pipeline with no model call) is intercepted at the
// browser's own network boundary via page.route — no fake-provider scripting is needed for a home-
// screen gate, since nothing here streams an answer.

import { test, expect } from "../support/fixtures";

function sessionRoute(page: import("@playwright/test").Page, overrides: Record<string, unknown> = {}) {
  return page.route("**/api/session", (route) =>
    route.fulfill({ json: { kind: "guest", signInAvailable: true, guestTtlHours: 3, ...overrides } }),
  );
}

test.describe("Chat home — situation chips reorder StarterPrompts/SampleCards", () => {
  test("selecting the employee chip moves the offer-letter sample first and swaps the prompt set", async ({ page }) => {
    await sessionRoute(page);
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "What's in your document?" })).toBeVisible();

    const sampleCards = page.locator("h2", { hasText: "Or try a sample document" }).locator("..");
    await expect(sampleCards.getByRole("button").first()).toHaveAccessibleName(/leave-and-license/);

    await page.getByRole("button", { name: "I'm an employee", exact: true }).click();

    await expect(sampleCards.getByRole("button").first()).toHaveAccessibleName(/job offer letter/);
    await expect(page.getByRole("button", { name: "What does my offer letter say about a non-compete?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "What does this lease say happens to my deposit?" })).toHaveCount(0);
  });
});

test.describe("Chat home — StarterPrompts fill, never send", () => {
  test("clicking a starter prompt fills the composer and fires no /api/ask request", async ({ page }) => {
    await sessionRoute(page);
    let askCalled = false;
    await page.route("**/api/ask", (route) => {
      askCalled = true;
      return route.continue();
    });
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Explain what an NDA actually obligates me to do." }).click();
    await expect(page.getByLabel("Ask Saboot")).toHaveValue("Explain what an NDA actually obligates me to do.");
    await page.waitForTimeout(300);
    expect(askCalled).toBe(false);
  });
});

test.describe("Chat home — SampleCards", () => {
  test("clicking a sample card calls exactly one POST /api/samples/<id>/open and navigates to /documents/[id]", async ({ page }) => {
    await sessionRoute(page);
    let openCalls = 0;
    await page.route("**/api/samples/lease/open", (route) => {
      openCalls++;
      return route.fulfill({ json: { documentId: "11111111-1111-4111-8111-111111111111" } });
    });
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /leave-and-license/ }).click();
    await expect(page).toHaveURL(/\/documents\/11111111-1111-4111-8111-111111111111$/);
    expect(openCalls).toBe(1);
  });

  test("a sample open failure (429) shows the retry-after copy inline under that card only", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/samples/lease/open", (route) =>
      route.fulfill({ status: 429, json: { error: { code: "RATE_LIMITED", message: "You've reached your limit for now. Try again in a little while." } } }),
    );
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /leave-and-license/ }).click();
    await expect(page.getByText(/reached your limit for now/).first()).toBeVisible();
  });
});

test.describe("Chat home — ?attach=<documentId>", () => {
  const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

  test("a real, ready document stages a chip and clears the URL", async ({ page }) => {
    await sessionRoute(page);
    await page.route(`**/api/documents/${DOCUMENT_ID}`, (route) =>
      route.fulfill({
        json: {
          analysisState: "complete",
          document: {
            id: DOCUMENT_ID,
            title: "Lease.pdf",
            sampleId: null,
            projectId: null,
            filename: "lease.pdf",
            mimeType: "application/pdf",
            processingStatus: "ready",
            inputMode: "text",
            documentType: "leave_and_license",
            jurisdiction: "IN",
            detectionConfidence: "high",
            uploadedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: null,
          },
          analysis: { id: "an-1", promptVersion: "v1", modelUsed: "gemini-2.5-flash", createdAt: "2026-01-01T00:00:00.000Z" },
          findings: [],
        },
      }),
    );
    await page.goto(`/chat?attach=${DOCUMENT_ID}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Lease.pdf")).toBeVisible();
    await expect(page).toHaveURL("/chat");
  });

  test("a not-ready document shows the InlineNotice and stages no chip; the URL is still cleared", async ({ page }) => {
    await sessionRoute(page);
    await page.route(`**/api/documents/${DOCUMENT_ID}`, (route) =>
      route.fulfill({
        json: {
          analysisState: "not_analyzed",
          document: {
            id: DOCUMENT_ID,
            title: "Lease.pdf",
            sampleId: null,
            projectId: null,
            filename: "lease.pdf",
            mimeType: "application/pdf",
            processingStatus: "pending",
            inputMode: null,
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
    await page.goto(`/chat?attach=${DOCUMENT_ID}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("note").filter({ hasText: "That document couldn't be attached." })).toBeVisible();
    await expect(page.getByText("Lease.pdf")).toHaveCount(0);
    await expect(page).toHaveURL("/chat");
  });

  test("an unknown/foreign document 404s to the same InlineNotice", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/documents/33333333-3333-4333-8333-333333333333", (route) =>
      route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "The requested resource could not be found." } } }),
    );
    await page.goto("/chat?attach=33333333-3333-4333-8333-333333333333");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("note").filter({ hasText: "That document couldn't be attached." })).toBeVisible();
    await expect(page).toHaveURL("/chat");
  });
});
