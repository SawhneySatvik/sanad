// F8's cross-screen walk: /library's own rename and delete round-trip against real documents, then
// /settings' "Delete all my data" clears every remaining item and every saboot:* localStorage key —
// end to end, through the real routes, not a page.route-mocked list. Every per-type cascade rule,
// cap and copy variant this flow doc's step table describes already has its own gate under
// tests/e2e/screens/**; this spec only proves rename, delete and delete-all as one real sequence.

import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";
import { uploadRawText } from "./_shared";

test.describe("F8 manage", () => {
  test("F8 manage: rename in the library -> delete with impact -> delete all my data @flow", async ({ page }) => {
    test.setTimeout(120_000);
    const nonce = `e2e-f8-${randomUUID()}`;
    // Matched by the nonce alone (present in both uploads' own text below), never the shared fixed
    // system-prompt sentence — a broad match would answer (or be answered by) any other
    // concurrently-running spec's own analyze call, a real cross-test collision the fake provider's
    // first-match-wins lookup never guards against. No tuned-type keyword cluster either, so even a
    // foreign broad script winning this race instead still parses against whatever type this text
    // detects as (see 03-workspace's own plant/cat fixture for the same reasoning).
    await registerScript({ id: nonce, match: nonce, chunks: [JSON.stringify({ findings: [] })] });

    const titleKeep = `${nonce}-keep.txt`;
    const titleDelete = `${nonce}-delete.txt`;
    await uploadRawText(page, titleKeep, `A document to keep. (ref: ${nonce}-keep)`);
    await uploadRawText(page, titleDelete, `A document to delete. (ref: ${nonce}-delete)`);

    // Scoped to the main landmark, not getByRole("table"): LibraryTable is a real <table> on
    // desktop but a plain <ul> on phone (no useful column headers there) — either way, this scope
    // still excludes the sidebar's own RecentsList row for this same, now-recent document.
    const table = page.getByRole("main");
    await page.goto("/library");
    await page.waitForLoadState("networkidle");

    // A non-thread saboot:* key, seeded directly — proves the delete-all sweep is a generic prefix
    // scan, not merely "clears the threads it happens to know about"
    await page.evaluate(() => window.localStorage.setItem("saboot:sidebar-collapsed:v1", "true"));

    const renamed = `${nonce}-renamed.txt`;
    await table.getByRole("button", { name: `Actions for ${titleKeep}` }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByLabel("Name", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(table.getByRole("link", { name: renamed, exact: true })).toBeVisible();

    await table.getByRole("button", { name: `Actions for ${titleDelete}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("alertdialog");
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(table.getByRole("link", { name: titleDelete, exact: true })).toHaveCount(0);
    await expect(table.getByRole("link", { name: renamed, exact: true })).toBeVisible();

    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Delete all my data" }).click();
    const allDataDialog = page.getByRole("alertdialog");
    await expect(allDataDialog).toBeVisible();
    await allDataDialog.getByRole("button", { name: "Delete all my data", exact: true }).click();
    await expect(page).toHaveURL(/\/chat$/, { timeout: 10_000 });

    const listResponse = await page.request.get("/api/documents");
    const { items } = (await listResponse.json()) as { items: { id: string }[] };
    expect(items).toEqual([]);

    const sabootKeys = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) => key.startsWith("saboot:")),
    );
    expect(sabootKeys).toEqual([]);
    const theme = await page.evaluate(() => window.localStorage.getItem("theme"));
    expect(theme).not.toBeNull();
  });
});
