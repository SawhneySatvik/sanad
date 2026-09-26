// F3's cross-screen walk: the workspace's own "Compare" deep link hands off to the picker with slot
// A already filled, picking a second document reaches the compare view, "Show this change" binds a
// span, and "Open in document" hands off to a plain, unhighlighted workspace. Screen-level detail
// (synced scroll, the scanned-document notice, the summary bar's own collapse state) lives under
// tests/e2e/screens/**; this spec only proves the handoffs and the end state.

import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";
import { isPhoneProject, uploadRawText } from "./_shared";

test.describe("F3 compare", () => {
  test("F3 compare: workspace deep link fills slot A -> pick slot B -> compare view -> show change -> open in document @flow", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const nonce = `e2e-f3-${randomUUID()}`;
    // Matched by the nonce alone, never the shared fixed system-prompt sentence — a broad match
    // would answer (or be answered by) any other concurrently-running spec's own analyze call, a
    // real cross-test collision the fake provider's first-match-wins lookup never guards against.
    // Registered once, then overwritten in place (same id) for the compare call below — the two
    // uploads' own analyze calls have already resolved by then.
    await registerScript({ id: nonce, match: nonce, chunks: [JSON.stringify({ findings: [] })] });

    const titleA = `${nonce}-before.txt`;
    const titleB = `${nonce}-after.txt`;
    // Content with no tuned-type keyword cluster (no "agreement", "services", "fee" — see
    // 03-workspace's own plant/cat fixture): if a foreign broad script ever did win this race, its
    // reply still parses against whatever type this text detects as.
    const documentAId = await uploadRawText(page, titleA, `The monthly amount is Rs. 10,000. (ref: ${nonce})`);
    await uploadRawText(page, titleB, `The monthly amount is Rs. 15,000. (ref: ${nonce})`);

    await page.goto(`/documents/${documentAId}`);
    await page.waitForLoadState("networkidle");

    if (isPhoneProject(testInfo)) {
      await page.locator("header").getByRole("button", { name: /^Actions for/ }).click();
      await page.getByRole("menuitem", { name: "Compare" }).click();
    } else {
      // Scoped to the workspace's own right pane — AppSidebar's standing nav also has a "Compare"
      // link (to a bare /compare, no ?a= prefill), a real, same-name collision, not a test artifact.
      await page.getByTestId("right-pane").getByRole("link", { name: "Compare", exact: true }).click();
    }

    await expect(page).toHaveURL(/\/compare$/, { timeout: 10_000 });
    await expect(page.locator('[aria-labelledby="slot-A-label"]')).toContainText(titleA);

    await page.getByRole("button", { name: titleB, exact: true }).click();

    await registerScript({
      id: nonce,
      match: nonce,
      chunks: [JSON.stringify({ changes: [{ id: "c1", explanation: "The monthly amount changed.", quoteA: "Rs. 10,000", quoteB: "Rs. 15,000" }] })],
    });
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page).toHaveURL(/\/compare\/[0-9a-f-]+$/, { timeout: 20_000 });
    await page.waitForLoadState("networkidle");

    if (isPhoneProject(testInfo)) {
      await page.getByRole("tab", { name: "Changes" }).click();
    } else {
      await page.getByRole("button", { name: /^Summary of changes/ }).click();
    }
    await page.getByRole("button", { name: "Show this change" }).click();
    await expect(page.locator("mark[data-active]")).toBeVisible();

    // On phone, activating "Show this change" switches the active tab to whichever document side
    // bound — the ChangeCard (and its "Open in document" link) live in the "Changes" tab, which
    // must be reselected to reach it again.
    if (isPhoneProject(testInfo)) await page.getByRole("tab", { name: "Changes" }).click();
    await page.getByRole("link", { name: "Open in document" }).click();
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/, { timeout: 10_000 });
    await expect(page.locator("mark[data-active]")).toHaveCount(0);
  });
});
