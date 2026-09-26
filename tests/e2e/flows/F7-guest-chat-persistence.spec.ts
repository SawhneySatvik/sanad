// F7's own centrepiece: a guest's grounded turn persists to localStorage through the real client
// write path (never seeded directly, unlike the screen-level storage-integrity gates), and reopening
// it re-verifies for real — the badge starts "Checking…" and only resolves once a genuine
// POST /api/verify-batch round trip against the live document text returns. The citation's own
// claimed quote is the source document's real text verbatim, so a real "verified" result on reopen
// is proof of a real re-verify, not merely a status this spec asserts. Every other assertion in this
// flow doc (the 20x50 storage caps, the sentinel hash, saved-thread paperclip disabling) already has
// its own gate under tests/e2e/screens/**.

import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";
import { openLeaseSample } from "./_shared";

test.describe("F7 guest chat persistence", () => {
  test("F7 guest chat persistence: a real grounded turn survives reload and re-verifies for real @flow", async ({ page }) => {
    test.setTimeout(120_000);
    const nonce = `e2e-f7-${randomUUID()}`;
    const documentId = await openLeaseSample(page);

    // A real, verified span from the lease sample's own findings — quoting it verbatim as the
    // citation's claimedQuote means the real verify() call on reopen has a real reason to answer
    // "verified", not a status this spec merely asserts.
    const getResponse = await page.request.get(`/api/documents/${documentId}`);
    const { findings } = (await getResponse.json()) as { findings: { verification: { status: string; spanText: string | null } | null }[] };
    const verifiedFinding = findings.find((f) => f.verification?.status === "verified");
    expect(verifiedFinding, "the lease sample must have at least one verified finding to quote").toBeTruthy();
    const realQuote = verifiedFinding!.verification!.spanText!;

    await page.goto(`/chat?attach=${documentId}`);
    // The attach param clears only after its own fetchDocument call settles, in the same
    // .then()/.finally() chain that stages the attachment — waiting for the clean URL is a reliable
    // proxy for "the document is now actually attached", not just "the page loaded".
    await page.waitForURL("/chat");
    await page.waitForLoadState("networkidle");

    await registerScript({
      id: nonce,
      match: nonce,
      chunks: [JSON.stringify({ answer: "Here is the relevant clause.", citations: [{ quote: realQuote, sourceDocumentId: documentId }] })],
    });
    await page.getByLabel("Ask Saboot").fill(`What does this say? (${nonce})`);
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("Here is the relevant clause.")).toBeVisible({ timeout: 20_000 });

    const threadUrl = page.url();
    expect(threadUrl).toMatch(/\/chat\/local-[0-9a-f-]+$/);

    await page.reload();
    // Badges never render from a cached local status first — a pending state is real proof the
    // client discarded whatever it stored and asked the server fresh.
    await expect(page.getByText("Checking…")).toBeVisible();
    await expect(page.getByText("Verified", { exact: true })).toBeVisible({ timeout: 15_000 });
  });
});
