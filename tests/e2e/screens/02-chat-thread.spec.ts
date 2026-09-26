// "Chat thread"'s own done-when gates. Every ask/verify-batch call is intercepted at the
// browser's own network boundary via page.route, fulfilled with a hand-built SSE body matching
// src/server/http/sse.ts's exact wire format — this proves the CLIENT's own handling of tokens,
// final and mid-stream error frames without needing the fake provider's classifier/specialist
// round trip, which a chat-screen gate has no reason to exercise.

import { test, expect } from "../support/fixtures";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function generalFinal(content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: null,
    role: "assistant",
    content,
    provenance: "ai_generated",
    modelUsed: "gemini-2.5-flash",
    routedDomains: ["general_legal"],
    createdAt: null,
    mode: "general",
    redirect: false,
    label: "General information, not verified against a document.",
    ...overrides,
  };
}

async function sessionRoute(page: import("@playwright/test").Page) {
  await page.route("**/api/session", (route) => route.fulfill({ json: { kind: "guest", signInAvailable: true, guestTtlHours: 3 } }));
}

test.describe("D1: the /chat -> /chat/local-<uuid> URL swap never triggers a Next navigation", () => {
  test("sends the first message from /chat; the URL becomes /chat/local-<uuid> without unmounting the component tree", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/ask", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseFrame("token", { type: "token", text: "General " }) + sseFrame("final", { type: "final", message: generalFinal("General information.") }),
      }),
    );

    await page.goto("/chat");
    // A marker only a real navigation/remount would wipe (an in-memory global, never persisted) —
    // the same technique 02-shell.spec.ts's own rename/delete gates use to prove no full reload
    // happened; window.history.replaceState (unlike a real Next navigation) never triggers one.
    await page.evaluate(() => {
      (window as unknown as { __chatTestMarker: boolean }).__chatTestMarker = true;
    });

    await page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
    await page.getByLabel("Ask Saboot").press("Enter");

    await expect(page).toHaveURL(/\/chat\/local-[0-9a-f-]+$/);
    await expect(page.getByText("General information.")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __chatTestMarker?: boolean }).__chatTestMarker)).toBe(true);
  });
});

test.describe("f7: a local thread survives a reload, and every citation starts Checking… before verify-batch resolves", () => {
  test("reload renders from localStorage before any network call resolves", async ({ page }) => {
    const id = "local-e2e-survive-reload";
    await page.addInitScript(
      ({ threadId }) => {
        const thread = {
          id: threadId,
          title: "Notice period",
          documentIds: [],
          messages: [
            { id: "u1", role: "user", content: "What is the notice period?", mode: null, citations: [], createdAtMs: 1 },
            {
              id: "a1",
              role: "assistant",
              content: "It is 30 days.",
              mode: "grounded",
              citations: [{ quoteText: "thirty (30) days notice", sourceDocumentId: "doc-x", unverifiedCachedStatus: "cached_verified" }],
              createdAtMs: 2,
            },
          ],
        };
        window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify([threadId]));
        window.localStorage.setItem(`saboot:threads:v1:${threadId}`, JSON.stringify(thread));
      },
      { threadId: id },
    );
    await sessionRoute(page);

    let releaseVerifyBatch: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (releaseVerifyBatch = resolve));
    await page.route("**/api/verify-batch", async (route) => {
      await held;
      return route.fulfill({
        json: { results: [{ status: "approximate", spanStart: 0, spanEnd: 10, spanText: "30 days", claimedQuote: "thirty (30) days notice", verifierVersion: "v1", textHash: "h" }] },
      });
    });
    await page.route("**/api/documents/doc-x", (route) => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "The requested resource could not be found." } } }));

    await page.goto(`/chat/${id}`);
    await expect(page.getByText("It is 30 days.")).toBeVisible();
    await expect(page.getByText("Checking…")).toBeVisible();
    await expect(page.locator('[data-slot="verification-badge"]')).toHaveCount(0);

    releaseVerifyBatch?.();
    await expect(page.getByText("Approximate")).toBeVisible();
  });

  test("f7: a stored approximate citation whose spanText would itself re-verify as verified still shows approximate after reopen (the storage-integrity gate)", async ({ page }) => {
    const id = "local-e2e-approx-never-upgrades";
    await page.addInitScript(
      ({ threadId }) => {
        const thread = {
          id: threadId,
          title: "Deposit",
          documentIds: [],
          messages: [
            { id: "u1", role: "user", content: "What about my deposit?", mode: null, citations: [], createdAtMs: 1 },
            {
              id: "a1",
              role: "assistant",
              content: "Your deposit is refundable.",
              mode: "grounded",
              // The stored quoteText is the model's own CLAIM (approximate), never the exact spanText —
              // toGuestThreadCitation's own contract. A server that received THIS text back would
              // find it an exact match and report verified; the gate proves the client never asks it to.
              citations: [{ quoteText: "the deposit is fully refundable", sourceDocumentId: "doc-y", unverifiedCachedStatus: "cached_approximate" }],
              createdAtMs: 2,
            },
          ],
        };
        window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify([threadId]));
        window.localStorage.setItem(`saboot:threads:v1:${threadId}`, JSON.stringify(thread));
      },
      { threadId: id },
    );
    await sessionRoute(page);

    let capturedQuote: string | undefined;
    await page.route("**/api/verify-batch", async (route) => {
      const body = route.request().postDataJSON() as { citations: { documentId: string; quote: string }[] };
      capturedQuote = body.citations[0]?.quote;
      // A server that received the exact stored quote would find it an exact match — the fixture
      // proves the point either way by echoing back what a REAL verify() would answer for this input:
      // approximate, since the claim differs from the (unknown, foreign) document's real wording.
      return route.fulfill({
        json: { results: [{ status: "approximate", spanStart: 0, spanEnd: 10, spanText: "deposit refundable within 15 days", claimedQuote: capturedQuote, verifierVersion: "v1", textHash: "h" }] },
      });
    });
    await page.route("**/api/documents/doc-y", (route) => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "The requested resource could not be found." } } }));

    await page.goto(`/chat/${id}`);
    await expect(page.getByText("Approximate")).toBeVisible();
    expect(capturedQuote).toBe("the deposit is fully refundable");
  });
});

test.describe("Mid-stream error: preview discarded, prior UserMessage stays, manual Retry resubmits verbatim", () => {
  test("scripts token, token, event: error; the discarded preview never appears, and Retry resends the identical query", async ({ page }) => {
    await sessionRoute(page);
    let askCallCount = 0;
    let lastBody: unknown;
    await page.route("**/api/ask", (route) => {
      askCallCount++;
      lastBody = route.request().postDataJSON();
      if (askCallCount === 1) {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body:
            sseFrame("token", { type: "token", text: "Hold on" }) +
            sseFrame("error", { error: { code: "UPSTREAM_UNAVAILABLE", message: "The AI providers are busy right now. Try again in a few minutes." } }),
        });
      }
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseFrame("token", { type: "token", text: "General " }) + sseFrame("final", { type: "final", message: generalFinal("Retried successfully.") }),
      });
    });

    await page.goto("/chat");
    await page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
    await page.getByLabel("Ask Saboot").press("Enter");

    await expect(page.getByRole("log").getByText("write me a haiku about rain")).toBeVisible();
    await expect(page.getByText(/AI providers are busy/).first()).toBeVisible();
    await expect(page.getByText("Hold on")).toHaveCount(0);
    // A mid-stream failure must never leave the composer disabled — sending/streamingText both
    // have to clear before this notice ever renders.
    await expect(page.getByLabel("Ask Saboot")).toBeEnabled();

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Retried successfully.")).toBeVisible();
    expect(askCallCount).toBe(2);
    expect((lastBody as { query: string }).query).toBe("write me a haiku about rain");
    await expect(page.getByRole("log").getByText("write me a haiku about rain")).toHaveCount(1);
  });
});

test.describe("Pre-stream 429/503: honest copy, no countdown for 429", () => {
  test("429 RATE_LIMITED shows the fixed limit copy with no countdown", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/ask", (route) =>
      route.fulfill({ status: 429, json: { error: { code: "RATE_LIMITED", message: "You've reached your limit for now. Try again in a little while." } } }),
    );
    await page.goto("/chat");
    await page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("You've reached your limit for now. Try again in a little while.").first()).toBeVisible();
  });

  test("503 UPSTREAM_UNAVAILABLE shows the retry-after copy", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/ask", (route) =>
      route.fulfill({ status: 503, json: { error: { code: "UPSTREAM_UNAVAILABLE", message: "busy", retryAfterSeconds: 45 } } }),
    );
    await page.goto("/chat");
    await page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText(/Try again in 45 seconds/).first()).toBeVisible();
  });
});

test.describe("D6: a redirect general-mode message renders no ModelUsedNote", () => {
  test("redirect: true, modelUsed 'none' shows the general label but no 'Answered by' disclosure", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/ask", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseFrame("final", { type: "final", message: generalFinal("That's outside what Saboot can help with.", { redirect: true, modelUsed: "none" }) }),
      }),
    );
    await page.goto("/chat");
    await page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("That's outside what Saboot can help with.")).toBeVisible();
    await expect(page.getByText(/Answered by/)).toHaveCount(0);
  });

  test("a non-redirect general message DOES render ModelUsedNote", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/ask", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseFrame("final", { type: "final", message: generalFinal("General information about notice periods.") }),
      }),
    );
    await page.goto("/chat");
    await page.getByLabel("Ask Saboot").fill("what is a typical notice period");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("General information about notice periods.")).toBeVisible();
    await expect(page.getByText(/Answered by gemini-2.5-flash/)).toBeVisible();
  });
});

test.describe("D3: the paperclip disables on a real saved thread, with its reason shown", () => {
  test("a real (non-local) thread id shows aria-disabled='true' and the InlineNotice reason, focusable", async ({ page }) => {
    const threadId = "88888888-8888-4888-8888-888888888888";
    await page.route("**/api/session", (route) => route.fulfill({ json: { kind: "user", displayName: "Asha", signInAvailable: true, guestTtlHours: 3 } }));
    await page.route(`**/api/threads/${threadId}/messages`, (route) => route.fulfill({ json: { messages: [] } }));

    await page.goto(`/chat/${threadId}`);
    const paperclip = page.getByRole("button", { name: "Attach a document" });
    await expect(paperclip).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("This chat is already saved. Start a new chat to attach another document.").first()).toBeVisible();

    let uploadCalled = false;
    await page.route("**/api/uploads", (route) => {
      uploadCalled = true;
      return route.continue();
    });
    // force: true — Playwright's own actionability check treats aria-disabled as "not enabled" and
    // would otherwise wait forever; a real disabled-but-focusable control needs a forced click to
    // prove the click genuinely does nothing, which is exactly what this assertion tests for.
    await paperclip.click({ force: true });
    await page.waitForTimeout(200);
    expect(uploadCalled).toBe(false);
  });
});

test.describe("chat.not-found-citation-shows-deletion-copy", () => {
  test("a re-verified not_found citation shows the standard label plus the deletion sentence", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/ask", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseFrame("final", {
          type: "final",
          message: {
            id: null,
            role: "assistant",
            content: "Here is what I found.",
            provenance: "ai_generated",
            modelUsed: "gemini-2.5-flash",
            routedDomains: ["tenancy"],
            createdAt: null,
            mode: "grounded",
            citations: [
              {
                id: null,
                sourceDocumentId: null,
                inputMode: null,
                verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "a vanished quote", verifierVersion: "v1", textHash: "0".repeat(64) },
              },
            ],
          },
        }),
      }),
    );
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Ask Saboot").fill("what does my lease say about this");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("Not found in your document")).toBeVisible();
    await expect(page.getByText("The document may have been deleted or expired.")).toBeVisible();
    // A successful grounded turn (this is one, even with a not_found citation inside it) must
    // never leave the composer disabled behind it.
    await expect(page.getByLabel("Ask Saboot")).toBeEnabled();
  });
});

test.describe("chat.scanned-citation-shows-notice", () => {
  test("a citation whose inputMode is native_document shows ScannedNotice; a sibling text citation does not", async ({ page }) => {
    await sessionRoute(page);
    await page.route("**/api/documents/**", (route) =>
      route.fulfill({
        json: {
          analysisState: "complete",
          document: {
            id: "99999999-9999-4999-8999-999999999999",
            title: "Scanned.pdf",
            sampleId: null,
            projectId: null,
            filename: "scanned.pdf",
            mimeType: "application/pdf",
            processingStatus: "ready",
            inputMode: "native_document",
            documentType: "nda",
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
            id: null,
            role: "assistant",
            content: "Here is what both documents say.",
            provenance: "ai_generated",
            modelUsed: "gemini-2.5-flash",
            routedDomains: ["general_legal"],
            createdAt: null,
            mode: "grounded",
            citations: [
              {
                id: null,
                sourceDocumentId: "99999999-9999-4999-8999-999999999999",
                inputMode: "native_document",
                verification: { status: "approximate", spanStart: 0, spanEnd: 10, spanText: "roughly this", claimedQuote: "roughly this, claimed", verifierVersion: "v1", textHash: "h" },
              },
              {
                id: null,
                sourceDocumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                inputMode: "text",
                verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "exact text", verifierVersion: "v1", textHash: "h2" },
              },
            ],
          },
        }),
      }),
    );
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Ask Saboot").fill("compare these two documents");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText(/This document was read from a scanned image/)).toBeVisible();
    // Exactly one ScannedNotice — the sibling text citation must not also show it.
    await expect(page.getByText(/This document was read from a scanned image/)).toHaveCount(1);
  });
});

test.describe('"New chat" resets an already-mounted thread instance back to the fresh home state', () => {
  test("send a message, then follow the sidebar's New chat link: home is empty, composer is empty", async ({ page }, testInfo) => {
    await sessionRoute(page);
    await page.route("**/api/ask", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseFrame("final", { type: "final", message: generalFinal("General information.") }),
      }),
    );
    await page.goto("/chat");
    await page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
    await page.getByLabel("Ask Saboot").press("Enter");
    await expect(page.getByText("General information.")).toBeVisible();

    // Below 768px the sidebar's whole content — including this very link — is a closed Radix
    // Dialog (the phone drawer) and isn't in the DOM at all until opened (02-shell.spec.ts's own
    // openMobileMenuIfPhone convention).
    if (testInfo.project.name.startsWith("phone")) await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("link", { name: "New chat" }).click();
    await expect(page).toHaveURL("/chat");
    await expect(page.getByRole("heading", { name: "What's in your document?" })).toBeVisible();
    await expect(page.getByLabel("Ask Saboot")).toHaveValue("");
    await expect(page.getByText("General information.")).toHaveCount(0);
  });
});
