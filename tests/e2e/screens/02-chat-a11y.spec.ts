// Chat's own axe + live-region allow-list gates. next dev's own overlay is excluded from every axe
// run, matching 02-shell.spec.ts's identical exclusion.

import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../support/fixtures";

const AXE_EXCLUDE = "nextjs-portal";
const LIVE_REGION_SELECTOR = '[aria-live], [role="alert"], [role="status"], [role="log"]';

async function sessionRoute(page: import("@playwright/test").Page) {
  await page.route("**/api/session", (route) => route.fulfill({ json: { kind: "guest", signInAvailable: true, guestTtlHours: 3 } }));
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test.describe("axe: chat home", () => {
  test("at rest — zero serious/critical", async ({ page }) => {
    await sessionRoute(page);
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).exclude(AXE_EXCLUDE).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("live-region allow-list: exactly the 3 chrome nodes, no role=log on the home screen", async ({ page }) => {
    await sessionRoute(page);
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");
    const nodes = await page.evaluate((selector) => Array.from(document.querySelectorAll(selector)).length, LIVE_REGION_SELECTOR);
    expect(nodes).toBe(3);
  });
});

test.describe("axe: chat thread", () => {
  test("a thread at rest with a resolved citation — zero serious/critical", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/documents/**", (route) =>
      route.fulfill({
        json: {
          analysisState: "complete",
          document: {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
    await page.route("**/api/ask", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseFrame("final", {
          type: "final",
          message: {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            role: "assistant",
            content: "Here is what the lease says.",
            provenance: "ai_generated",
            modelUsed: "gemini-2.5-flash",
            routedDomains: ["tenancy"],
            createdAt: null,
            mode: "grounded",
            citations: [
              {
                id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                sourceDocumentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                inputMode: "text",
                verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "exact wording", verifierVersion: "v1", textHash: "h" },
              },
            ],
          },
        }),
      }),
    );
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Ask Saboot").fill("what does my lease say");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("Here is what the lease says.")).toBeVisible();

    const results = await new AxeBuilder({ page }).exclude(AXE_EXCLUDE).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("live-region allow-list on the thread screen: the 3 chrome nodes plus role=log", async ({ page }) => {
    const id = "local-e2e-a11y-log";
    await page.addInitScript(
      ({ threadId }) => {
        const thread = { id: threadId, title: "T", documentIds: [], messages: [] };
        window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify([threadId]));
        window.localStorage.setItem(`saboot:threads:v1:${threadId}`, JSON.stringify(thread));
      },
      { threadId: id },
    );
    await sessionRoute(page);
    await page.goto(`/chat/${id}`);
    await page.waitForLoadState("networkidle");
    const nodes = await page.evaluate((selector) => Array.from(document.querySelectorAll(selector)).length, LIVE_REGION_SELECTOR);
    expect(nodes).toBe(4);
    const roleLogCount = await page.evaluate(() => document.querySelectorAll('[role="log"]').length);
    expect(roleLogCount).toBe(1);
  });

  // A genuine mid-stream hold needs the underlying HTTP response to stay open and flush
  // incrementally — page.route's own fulfill() only ever sends one complete, already-closed
  // response, so a "hold" built on it delivers every frame (including `final`) in one burst
  // instead of actually pausing between them. That real hold-and-release mechanism belongs to the
  // fake provider (a live model round trip), which this client-only screen test has no reason to
  // drive; the equivalent assertion — StreamingPreview visible, then axe run against exactly that
  // state — is covered at the component level instead (tests/unit/components/chat/axe.test.tsx),
  // where a mocked fetch can be held open indefinitely under full control.
});
