// Compare's own scoped-down gate: picker -> compare -> select change -> highlight on the correct
// side, plus one axe check per surface. Synced scroll, the phone cross-tab affordance, the
// scanned-document notice and the identical-documents case are not covered here.

import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";

const AXE_EXCLUDE = "nextjs-portal";
const ANALYZE_PROMPT_MATCH = "You help people in India understand legal documents";

interface UploadTarget {
  method: string;
  uploadUrl: string;
  ref: string;
}

async function uploadRawText(page: import("@playwright/test").Page, filename: string, text: string): Promise<string> {
  const bytes = Buffer.from(text, "utf8");
  const targetResponse = await page.request.post("/api/uploads", { data: { filename, mimeType: "text/plain", sizeBytes: bytes.byteLength } });
  expect(targetResponse.ok(), await targetResponse.text()).toBe(true);
  const target = (await targetResponse.json()) as UploadTarget;
  const relayResponse = await page.request.put(target.uploadUrl, { data: bytes });
  expect(relayResponse.ok(), await relayResponse.text()).toBe(true);
  const confirmResponse = await page.request.post("/api/documents", { data: { storageRef: target.ref, filename, mimeType: "text/plain" } });
  expect(confirmResponse.ok(), await confirmResponse.text()).toBe(true);
  const body = (await confirmResponse.json()) as { document: { id: string } };
  return body.document.id;
}

function isPhoneProject(testInfo: import("@playwright/test").TestInfo): boolean {
  return testInfo.project.name.startsWith("phone");
}

async function stubIncidentalSidebarLists(page: import("@playwright/test").Page): Promise<void> {
  const empty = { items: [], nextCursor: null };
  await page.route("**/api/drafts", (route) => route.fulfill({ json: empty }));
  await page.route("**/api/threads", (route) => route.fulfill({ json: empty }));
}

test.describe("Compare — picker to detail, select a change, highlight lands on the right side", () => {
  test("compare.picker-compare-select-highlights-correct-side", async ({ page }, testInfo) => {
    // A generous timeout: this run includes two uploads, two Understand analyze calls, a Compare
    // call, and the first-ever compile of /compare and /compare/[id] under four workers competing
    // for the same CPU — the default budget is tight for a cold Turbopack compile specifically.
    test.setTimeout(75_000);
    await stubIncidentalSidebarLists(page);
    const nonce = `e2e-compare-${randomUUID()}`;

    // Registered before either upload: matched by the fixed opening sentence every
    // findings-extraction call shares, never by the nonce below.
    await registerScript({ id: `${nonce}-analyze`, match: ANALYZE_PROMPT_MATCH, chunks: [JSON.stringify({ findings: [] })] });

    const beforeText = `This services agreement is between a freelancer and a client for general consulting work. The monthly fee for these services is Rs. 10,000, payable by the fifth of each month. (ref: ${nonce})`;
    const afterText = `This services agreement is between a freelancer and a client for general consulting work. The monthly fee for these services is Rs. 15,000, payable by the fifth of each month. (ref: ${nonce})`;
    const documentAId = await uploadRawText(page, "e2e-before.txt", beforeText);
    const documentBId = await uploadRawText(page, "e2e-after.txt", afterText);

    await page.goto("/compare");
    await page.waitForLoadState("networkidle");
    // Exactly one "not legal advice" line on the picker (AppShell's own footer supplies it — this
    // screen adds no second copy).
    await expect(page.getByText("Saboot explains documents. It isn't legal advice.")).toHaveCount(1);

    const pickerAxe = await new AxeBuilder({ page }).exclude(AXE_EXCLUDE).analyze();
    expect(pickerAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

    await page.getByRole("button", { name: "e2e-before.txt", exact: true }).click();
    await page.getByRole("button", { name: "e2e-after.txt", exact: true }).click();

    // Registered only now, after both analyze calls already fired against the broader script above.
    await registerScript({
      id: `${nonce}-compare`,
      match: nonce,
      chunks: [
        JSON.stringify({
          changes: [{ id: "c1", explanation: "The monthly fee changed from Rs. 10,000 to Rs. 15,000.", quoteA: "Rs. 10,000", quoteB: "Rs. 15,000" }],
        }),
      ],
    });

    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.waitForURL(/\/compare\/[0-9a-f-]+$/, { timeout: 20_000 });
    await page.waitForLoadState("networkidle");

    const comparisonId = page.url().split("/compare/")[1];
    const comparisonResponse = await page.request.get(`/api/comparisons/${comparisonId}`);
    expect(comparisonResponse.ok(), await comparisonResponse.text()).toBe(true);
    const comparison = (await comparisonResponse.json()) as {
      documentAId: string;
      documentBId: string;
      changes: { verificationA: { status: string } | null; verificationB: { status: string } | null }[];
    };
    expect(comparison.documentAId).toBe(documentAId);
    expect(comparison.documentBId).toBe(documentBId);
    // One side per activation: side A wins whenever it binds at all — derived from the live
    // response rather than hard-coded, so this assertion tracks the real verify() run.
    const expectedSide = comparison.changes[0].verificationA ? "A" : "B";

    await expect(page.getByText("Saboot explains documents. It isn't legal advice.")).toHaveCount(1);

    if (isPhoneProject(testInfo)) {
      await page.getByRole("tab", { name: "Changes" }).click();
    } else {
      await page.getByRole("button", { name: "Summary of changes (1)" }).click();
    }
    await page.getByRole("button", { name: "Show this change" }).click();

    if (!isPhoneProject(testInfo)) {
      // Phone mounts only the active tab's DocumentViewer — the other side's pane isn't in the DOM
      // at all to assert a zero count against.
      const otherSide = expectedSide === "A" ? documentBId : documentAId;
      expect(await page.locator(`[data-document-id="${otherSide}"] mark[data-active]`).count()).toBe(0);
    }

    const winningDocumentId = expectedSide === "A" ? documentAId : documentBId;
    const winningMark = page.locator(`[data-document-id="${winningDocumentId}"] mark[data-active]`);
    await expect(winningMark).toBeVisible();
    const focusedIsMark = await page.evaluate(() => document.activeElement?.tagName === "MARK");
    expect(focusedIsMark).toBe(true);

    const politeText = await page.locator('div.sr-only[aria-live="polite"]').textContent();
    expect(politeText).toBe(`Showing this change in Document ${expectedSide}.`);

    const detailAxe = await new AxeBuilder({ page }).exclude(AXE_EXCLUDE).analyze();
    expect(detailAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
