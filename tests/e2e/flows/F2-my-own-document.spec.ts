// F2's cross-screen walk: /chat's own attach affordance stages a real, freshly-analysed document as
// an attachment, a grounded question cites it, and clicking that citation hands off to the analysis
// workspace for that exact document. Screen-level detail (the upload reason matrix, category
// grouping, the verifier demo) lives under tests/e2e/screens/**; this spec only proves the handoffs
// and the end state.

import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";

test.describe("F2 my own document", () => {
  test("F2 my own document: chat upload -> grounded ask -> citation hands off to the workspace @flow", async ({ page }) => {
    test.setTimeout(120_000);
    const nonce = `e2e-f2-${randomUUID()}`;
    // Matched by the nonce alone, never the shared fixed system-prompt sentence — a broad match
    // would answer (or be answered by) any other concurrently-running spec's own analyze call, a
    // real cross-test collision the fake provider's first-match-wins lookup never guards against.
    // Registered once, then overwritten in place (same id) for the ask call below — the upload's
    // own analyze call has already resolved by then.
    await registerScript({ id: nonce, match: nonce, chunks: [JSON.stringify({ findings: [] })] });

    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    const filename = `${nonce}.txt`;
    // No tuned-type keyword cluster ("agreement", "services", "fee" — see 03-workspace's own
    // plant/cat fixture): if a foreign broad script ever won this race instead, its reply still
    // parses against whatever type this text detects as.
    const content = `The monthly amount mentioned here matters. (ref: ${nonce})`;

    const [confirmResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/documents") && response.request().method() === "POST"),
      page.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "text/plain", buffer: Buffer.from(content, "utf8") }),
    ]);
    const { document } = (await confirmResponse.json()) as { document: { id: string } };
    const documentId = document.id;

    // The chip's own remove control (never a bare getByText(filename), which also matches this same
    // document's RecentsList sidebar row once its own, separately-timed query catches up) is the
    // observable proof the upload reached analysisState "complete" and is now grounding the next
    // turn — the composer stays on /chat the whole time (there is no auto-redirect to the workspace
    // on a chat-composer upload, unlike a first-run upload's own AnalyzeDocumentOutput redirect
    // narrated elsewhere).
    await expect(page.getByRole("button", { name: `Remove ${filename}` })).toBeVisible({ timeout: 20_000 });

    // The quote is the uploaded text verbatim, so the real, live verify() call this Ask turn triggers
    // genuinely marks the citation "verified" — never a status this spec merely asserts, but one the
    // server actually computes against the real canonical text.
    await registerScript({
      id: nonce,
      match: nonce,
      chunks: [JSON.stringify({ answer: "Here is what the document covers.", citations: [{ quote: content, sourceDocumentId: documentId }] })],
    });

    // The query text itself never carries the nonce — only the uploaded document's own content
    // does, so the fake provider's match only fires if the attached document actually reached the
    // specialist prompt (mode: "grounded"), never merely because the question happened to.
    await page.getByLabel("Ask Saboot").fill("What does this document cover?");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("Here is what the document covers.")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /^Jump to citation in/ }).click();
    await expect(page).toHaveURL(`/documents/${documentId}`, { timeout: 10_000 });
  });
});
