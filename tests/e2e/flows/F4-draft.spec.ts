// F4's cross-screen walk: the workspace's own "Draft a reply" deep link hands off to /drafts/new
// with grounded mode already preselected, drafting hands off to /drafts/[id] with "Based on:"
// linking back to the source document, and revising hands off to a new revision whose timeline
// shows the whole chain. Screen-level detail (provenance labels, export, the branching case) lives
// under tests/e2e/screens/**; this spec only proves the handoffs and the end state.

import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";
import { isPhoneProject, openLeaseSample } from "./_shared";

// The grounded_response template's own three AI-generated sections (registry.ts's groundedResponse) —
// disclaimer/closing are templated, never supplied by the model.
const DRAFT_SECTIONS = {
  summary_of_what_you_received: "You received a lease agreement asking about a short extension.",
  your_response: "Dear Landlord, I would like to request a short extension to the lease term.",
  next_steps: "You should confirm the new end date in writing once agreed.",
};

test.describe("F4 draft", () => {
  test("F4 draft: workspace grounded deep link -> draft -> based-on link -> revise -> timeline @flow", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const nonce = `e2e-f4-${randomUUID()}`;
    // One script answers both the create and the revise call — both submit an instructions string
    // containing this same nonce, and the response content itself doesn't matter to this spec.
    await registerScript({ id: nonce, match: nonce, chunks: [JSON.stringify({ sections: DRAFT_SECTIONS })] });

    const documentId = await openLeaseSample(page);
    await page.goto(`/documents/${documentId}`);
    await page.waitForLoadState("networkidle");

    if (isPhoneProject(testInfo)) {
      await page.locator("header").getByRole("button", { name: /^Actions for/ }).click();
      await page.getByRole("menuitem", { name: "Draft a reply" }).click();
    } else {
      await page.getByTestId("right-pane").getByRole("link", { name: "Draft a reply", exact: true }).click();
    }

    await expect(page).toHaveURL(/\/drafts\/new$/, { timeout: 10_000 });
    await expect(page.getByRole("radio", { name: "Respond to a document you have" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Document to respond to" })).toContainText("leave-and-license-sample.txt");

    await page.getByLabel(/what do you want this draft to say/i).fill(`${nonce} reply agreeing to a short extension`);
    await page.getByRole("button", { name: "Draft", exact: true }).click();

    await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]+$/, { timeout: 20_000 });
    const firstDraftUrl = page.url();
    await expect(page.getByRole("link", { name: /^Based on:/ })).toBeVisible({ timeout: 20_000 });

    await page.getByLabel("Revise this draft").fill(`${nonce} shorten the notice period`);
    await page.getByRole("button", { name: "Revise", exact: true }).click();

    // Not a plain toHaveURL: the redirect briefly leaves the URL still matching the same
    // /drafts/[id] shape on the FIRST id before the revise round trip actually lands on a new one —
    // this poll is what proves it moved, given the real LLM round trip's own timing.
    await expect.poll(() => page.url(), { timeout: 20_000 }).not.toBe(firstDraftUrl);

    if (isPhoneProject(testInfo)) await page.getByRole("button", { name: "Revisions (2)" }).click({ timeout: 30_000 });
    await expect(page.locator("ol li")).toHaveCount(2, { timeout: 30_000 });
  });
});
