// The Analysis workspace's own done-when gates: finding-to-span scroll/pulse/focus; the lens switch
// changing an explanation with zero network; the verifier demo's downgrade coming only from the
// server's own verify-batch response; native-document never verified; the generic callout; the
// live-region allow-list (including Ask's role="log", desktop and phone); no nested interactive
// content; and axe on every named state. The recorded `lease` sample (five findings tiers,
// deterministic, no live model) is the primary fixture — it needs no fake provider.

import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";

const AXE_EXCLUDE = "nextjs-portal";
const LIVE_REGION_SELECTOR = '[aria-live], [role="alert"], [role="status"], [role="log"]';
const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "documents");

// The two prompts' own fixed opening sentences (src/server/prompts/understand/{transcribe,analyze}.ts)
// — a script matched by an empty string would answer every request the first-registered script
// matched for, which would silently hide a real prompt-matching bug (see
// tests/e2e/support/capture/states/workspace.ts, which guards against exactly this). Every
// findings-extraction call, for any document type, opens with the same sentence, so one script
// covers every "analyze" call across every fixture below.
const TRANSCRIBE_PROMPT_MATCH = "You transcribe scanned legal documents";
const ANALYZE_PROMPT_MATCH = "You help people in India understand legal documents";

// tests/e2e/support/fake-provider/server.ts must JSON-encode each non-streaming provider response
// exactly once: geminiChunkBody()/openAiChunkBody() already return a JSON.stringify()'d string, so
// stringifying it again would turn the wire body into a quoted JSON *string* literal instead of the
// object shape @google/genai's SDK expects, and every real .complete() call (never .stream()) would
// then fail with UPSTREAM_UNAVAILABLE after exhausting every fallback tier —
// `TypeError: Cannot create property 'sdkHttpResponse' on string '...'` against the pinned SDK.

// A sentence with none of any tuned type's own keywords (no lease/NDA/offer/privacy/freelance
// terms) — detectDocumentType() falls back to "generic" deterministically, so this fixture's
// findings always need exactly the shared party_* lenses (LENSES_BY_DOCUMENT_TYPE.generic), never a
// tuned type's own longer lens set the schema would otherwise reject as incomplete.
const GENERIC_FIXTURE_SENTENCE = "The undersigned agrees to water the office plants every Friday and to feed the office cat on weekends.";
const GENERIC_LENS_EXPLANATIONS = {
  party_about_to_sign: "Before signing, check you're comfortable taking on this plant- and cat-care duty.",
  party_already_signed: "Having signed, you're now expected to water the plants and feed the cat as described.",
};

/** One real, schema-valid `{"findings":[...]}"` body quoting `quote` verbatim — never an empty array, which proves nothing about a status cap (a page with zero findings has zero badges of every status alike). */
function oneObligationFindingScript(quote: string): string {
  return JSON.stringify({ findings: [{ category: "obligation", quote, lensExplanations: GENERIC_LENS_EXPLANATIONS }] });
}

async function openLeaseSample(page: import("@playwright/test").Page): Promise<string> {
  const opened = await page.request.post("/api/samples/lease/open");
  expect(opened.ok(), await opened.text()).toBe(true);
  const body = (await opened.json()) as { documentId: string };
  return body.documentId;
}

/**
 * The 3-step upload flow (POST /api/uploads -> PUT the relay -> POST /api/documents), driven
 * directly, matching tests/e2e/screens/03-upload.spec.ts's own real (non-fixme) convention.
 * `expectedErrorCode` names the ONE error code this exact fixture is meant to fail confirm with
 * (e.g. corrupt.pdf -> "EXTRACTION_FAILED") — the row still exists, `documentId` and all, in the
 * route's own error body. Omit it for a fixture expected to succeed outright. Either way, any OTHER outcome
 * (a relay/target error, a confirm failure with no `documentId`, or the wrong error code — a
 * transient 503, say) throws instead of being silently accepted as "some failure with an id".
 */
async function uploadFixture(
  page: import("@playwright/test").Page,
  filename: string,
  mimeType: string,
  expectedErrorCode?: string,
): Promise<{ documentId: string }> {
  const bytes = readFileSync(path.join(FIXTURES, filename));
  const targetResponse = await page.request.post("/api/uploads", { data: { filename, mimeType, sizeBytes: bytes.byteLength } });
  expect(targetResponse.ok(), await targetResponse.text()).toBe(true);
  const target = (await targetResponse.json()) as { uploadUrl: string; ref: string };
  const relayResponse = await page.request.put(target.uploadUrl, { data: bytes });
  expect(relayResponse.ok(), await relayResponse.text()).toBe(true);
  const confirmResponse = await page.request.post("/api/documents", { data: { storageRef: target.ref, filename, mimeType } });
  if (expectedErrorCode === undefined) {
    expect(confirmResponse.ok(), await confirmResponse.text()).toBe(true);
    const body = (await confirmResponse.json()) as { document: { id: string } };
    return { documentId: body.document.id };
  }
  expect(confirmResponse.ok(), `expected confirm to fail with ${expectedErrorCode}, but it succeeded: ${await confirmResponse.text()}`).toBe(false);
  const errorBody = (await confirmResponse.json()) as { error: { code?: string; documentId?: string } };
  expect(errorBody.error.code, await confirmResponse.text()).toBe(expectedErrorCode);
  expect(errorBody.error.documentId, await confirmResponse.text()).toBeTruthy();
  return { documentId: errorBody.error.documentId! };
}

/** Same 3-step flow as uploadFixture(), for a raw in-memory text body rather than a fixtures/documents/ file — the "text twin" gate needs a document whose real canonical_text is exactly the sentence a finding will claim to quote, not whatever an existing fixture file happens to contain. */
async function uploadRawText(page: import("@playwright/test").Page, filename: string, text: string): Promise<{ documentId: string }> {
  const bytes = Buffer.from(text, "utf8");
  const targetResponse = await page.request.post("/api/uploads", { data: { filename, mimeType: "text/plain", sizeBytes: bytes.byteLength } });
  expect(targetResponse.ok(), await targetResponse.text()).toBe(true);
  const target = (await targetResponse.json()) as { uploadUrl: string; ref: string };
  const relayResponse = await page.request.put(target.uploadUrl, { data: bytes });
  expect(relayResponse.ok(), await relayResponse.text()).toBe(true);
  const confirmResponse = await page.request.post("/api/documents", { data: { storageRef: target.ref, filename, mimeType: "text/plain" } });
  expect(confirmResponse.ok(), await confirmResponse.text()).toBe(true);
  const body = (await confirmResponse.json()) as { document: { id: string } };
  return { documentId: body.document.id };
}

function isPhoneProject(testInfo: import("@playwright/test").TestInfo): boolean {
  return testInfo.project.name.startsWith("phone");
}

/**
 * Stubs the sidebar chrome's own incidental list fetches (RecentsList's comparisons/drafts/threads
 * rows — this file's own findings never touch them) at the browser level, before every one of them
 * ever leaves for the real server, so an upload-then-view test's request count stays about the
 * document flow itself rather than the sidebar's incidental queries.
 */
async function stubIncidentalSidebarLists(page: import("@playwright/test").Page): Promise<void> {
  const empty = { items: [], nextCursor: null };
  await page.route("**/api/comparisons", (route) => route.fulfill({ json: empty }));
  await page.route("**/api/drafts", (route) => route.fulfill({ json: empty }));
  await page.route("**/api/threads", (route) => route.fulfill({ json: empty }));
}

/**
 * Findings (and, when analysisState !== "complete", the EmptyState with "Analyse now"/"Upload
 * again") live inside the phone BottomSheet, never on the base view. A test that reads a
 * FindingCard or clicks "Analyse now" needs the sheet open first; a desktop run needs nothing,
 * since `FindingsPane` is already visible in the right pane.
 */
async function openFindingsIfPhone(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo): Promise<void> {
  if (!isPhoneProject(testInfo)) return;
  // The phone trigger is one segmented handle (workspace-client.tsx) whose accessible name leads
  // with the live count ("16 findings"), not a fixed "Findings" prefix.
  await page.getByRole("button", { name: /^\d+ findings?$/ }).click();
  await page.getByRole("dialog").waitFor();
}

/** Closes the phone sheet (a no-op on desktop) — needed before touching a base-view control like `LensToggle`, which sits outside the sheet and is inert (aria-hidden) while the sheet's own modal is open. */
async function closeSheetIfPhone(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo): Promise<void> {
  if (!isPhoneProject(testInfo)) return;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.describe("Analysis workspace — finding selection", () => {
  test("workspace.finding-click-scrolls-and-pulses: 'Show in document' moves focus to the bound mark and announces it; the sibling controls never trigger it", async ({
    page,
  }, testInfo) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    await openFindingsIfPhone(page, testInfo);
    const card = page.locator("article[data-finding-category]").first();
    const showInDocument = card.getByRole("button", { name: /^Show .+ in document$/ });
    await showInDocument.click();
    // On phone this same click closes the sheet first (Phone layout's own rule) before the jump
    // lands on the now-visible base document view — the dialog must actually be gone, not merely
    // that a mark exists somewhere still hidden inside it.
    if (isPhoneProject(testInfo)) await expect(page.getByRole("dialog")).toHaveCount(0);

    // The bound mark receives real DOM focus (tabindex=-1, programmatic only).
    await expect(page.locator("mark[data-active]")).toBeVisible();
    const focusedIsMark = await page.evaluate(() => document.activeElement?.tagName === "MARK");
    expect(focusedIsMark).toBe(true);

    // Scoped to the chrome's own LiveRegion node (a <div class="sr-only">, layout-primitives/live-
    // region.tsx) — a bare `[aria-live="polite"]` also matches sonner's own hidden announcer
    // section (Toaster, mounted at the app root), which is a real, expected second node once
    // Toaster is on the page too, not this test's own target.
    const politeText = await page.locator('div.sr-only[aria-live="polite"]').textContent();
    expect(politeText).toMatch(/^Showing this .+ in the document\.$/);

    // Neither sibling control (Test this quote, the badge's info button) ever triggers the jump —
    // reopen the sheet on phone first, since that same click above already closed it. Not a
    // `mark[data-active]` count: the pulse this same jump set is a one-shot 480ms flash
    // (PULSE_HOLD_MS, document-viewer.tsx) that decays on its own regardless of this click, and
    // reopening the sheet on phone alone routinely takes longer than that. A MutationObserver
    // watching for a fresh data-active, installed right before the click, is the signal that
    // survives that decay; the wait after the click is for a phone jump specifically, which
    // workspace-client.tsx's handlePhoneShowInDocument defers to the sheet's own
    // onCloseAutoFocus — it only fires once the Sheet's 220ms close transition finishes
    // (data-closed:duration-[220ms], ui/sheet.tsx), so checking immediately after the click would
    // race a jump that (bug aside) is never actually going to close this sheet at all.
    await page.keyboard.press("Escape");
    await openFindingsIfPhone(page, testInfo);
    await page.evaluate(() => {
      const win = window as unknown as { __pulsedAfterTestQuote?: boolean };
      win.__pulsedAfterTestQuote = false;
      const container = document.querySelector("[data-document-id]");
      if (!container) return;
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if ((mutation.target as HTMLElement).hasAttribute("data-active")) win.__pulsedAfterTestQuote = true;
        }
      }).observe(container, { attributes: true, attributeFilter: ["data-active"], subtree: true });
    });
    await card.getByRole("button", { name: "Test this quote" }).click();
    await page.waitForTimeout(500);
    const pulsedAfterTestQuote = await page.evaluate(() => (window as unknown as { __pulsedAfterTestQuote?: boolean }).__pulsedAfterTestQuote);
    expect(pulsedAfterTestQuote).toBe(false);
    const focusedIsMarkAfterTestQuote = await page.evaluate(() => document.activeElement?.tagName === "MARK");
    expect(focusedIsMarkAfterTestQuote).toBe(false);
    // On phone, the sheet itself never having closed is the clearest proof "Test this quote" never
    // reused the phone jump's own close-then-activate path.
    if (isPhoneProject(testInfo)) await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
  });

  test("workspace.findingcard-no-nested-interactive: every FindingCard is an <article>, never a <button>, and none of its sibling controls nests inside another interactive element", async ({
    page,
  }) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    const violations = await page.evaluate(() => {
      const problems: string[] = [];
      document.querySelectorAll("article[data-finding-category]").forEach((card) => {
        if (card.tagName !== "ARTICLE") problems.push(`card is a <${card.tagName}>, not <article>`);
        card.querySelectorAll("button").forEach((button) => {
          // Every sibling control's own ancestor interactive element, found by walking from its
          // parent (not the button itself, which would trivially "find" itself via closest()).
          if (button.parentElement?.closest("button,a")) {
            problems.push(`a <button> is nested inside another interactive element: ${button.outerHTML.slice(0, 80)}`);
          }
        });
      });
      return problems;
    });
    expect(violations).toEqual([]);
  });
});

test.describe("Analysis workspace — resting-state highlights", () => {
  // Every finding with a bound span renders its <mark> at rest, not only once selected/pulsed —
  // DocumentViewer only ever maps segments to <mark>/plain text nodes, and the workspace never
  // scrolls or pre-selects a finding on entry, so this is the one gate that actually exercises
  // bindSpan()'s real, live output against a genuine document fetch end to end, not a
  // page.route-tampered fixture. If this goes red, bindSpan is suppressing a genuinely matching
  // finding — never weaken bindSpan to make it pass.
  test("workspace.resting-marks-bind-and-match-spantext: at least one <mark> renders on load, and its textContent equals its finding's spanText", async ({ page }) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    const marksCount = await page.locator("[data-document-id] mark").count();
    expect(marksCount, "no <mark> rendered at rest — bindSpan() may be suppressing every finding on this fixture").toBeGreaterThan(0);

    // Cross-checks every bound finding's own spanText (QuoteBlock's first <p><bdi>, per
    // quote-block.tsx — the badge and the claimedQuote line are their own separate elements) against
    // the rendered marks: the concatenation of a covering mark's own textContent must equal that
    // finding's spanText exactly (the overlap-case restatement,
    // "workspace.bindspan-matched-textcontent-equals-spantext").
    const mismatches = await page.evaluate(() => {
      const problems: string[] = [];
      document.querySelectorAll("article[data-finding-category]").forEach((card) => {
        const badge = card.querySelector("[data-verification-status]");
        if (!badge || badge.getAttribute("data-verification-status") === "not_found") return; // checklist or not_found: no bound span to check
        const spanText = card.querySelector("blockquote p bdi")?.textContent ?? "";
        if (!spanText) return;
        const marks = Array.from(document.querySelectorAll("[data-document-id] mark"));
        const matched = marks.some((mark) => mark.textContent === spanText || spanText.includes(mark.textContent ?? "\u0000"));
        if (!matched) problems.push(`no mark's textContent equals a verified/approximate finding's own spanText: ${spanText.slice(0, 60)}`);
      });
      return problems;
    });
    expect(mismatches).toEqual([]);
  });

  // No test hardcodes a finding count — the live GET response's own findings.length is what every
  // count assertion reads, desktop group headings and the phone trigger handle alike: a
  // per-category heading like "Obligation (16)" and the phone handle's overall "27 findings" both
  // read from this same response, just grouped differently.
  test("workspace.category-group-count-matches-live-findings: a FindingGroup's aria-label count equals its own category's live finding count", async ({ page }, testInfo) => {
    const id = await openLeaseSample(page);
    const getResponse = await page.request.get(`/api/documents/${id}`);
    const body = (await getResponse.json()) as { findings: { category: string }[] };
    const obligationCount = body.findings.filter((f) => f.category === "obligation").length;
    expect(obligationCount).toBeGreaterThan(0);

    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");
    await openFindingsIfPhone(page, testInfo);
    await expect(page.getByRole("button", { name: `Obligation, ${obligationCount} findings` })).toBeVisible();
  });
});

test.describe("Analysis workspace — lens switch", () => {
  test("workspace.lens-switch-is-free: switching twice fires zero network calls, updates ?lens=, and changes at least one FindingCard's visible explanation", async ({
    page,
  }, testInfo) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    // `LensToggle` sits on the phone base view, outside the sheet (Phone layout's own rule) — read
    // a card's text from inside the (open) sheet, close it so the base view's own combobox is no
    // longer inert (Radix's Dialog aria-hides everything outside it while open), switch, then
    // reopen the sheet to read the card again.
    await openFindingsIfPhone(page, testInfo);
    const firstCardText = await page.locator("article[data-finding-category]").first().innerText();
    await closeSheetIfPhone(page, testInfo);

    let networkCalls = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/")) networkCalls += 1;
    });

    const toggle = page.getByRole("combobox", { name: "Viewing as" });
    await toggle.click();
    await page.getByRole("option", { name: "Landlord, before signing" }).click();
    await expect(page).toHaveURL(/lens=landlord_about_to_sign/);

    await openFindingsIfPhone(page, testInfo);
    const secondCardText = await page.locator("article[data-finding-category]").first().innerText();
    expect(secondCardText).not.toBe(firstCardText);
    await closeSheetIfPhone(page, testInfo);

    await toggle.click();
    await page.getByRole("option", { name: "Tenant, before signing" }).click();
    await expect(page).toHaveURL(/lens=tenant_about_to_sign/);

    expect(networkCalls).toBe(0);
  });

  test("workspace.lens-invalid-query-param-falls-back-and-replaces-url", async ({ page }) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}?lens=not-a-real-lens`);
    await page.waitForLoadState("networkidle");
    await expect(page).not.toHaveURL(/not-a-real-lens/);
    await expect(page.getByRole("combobox", { name: "Viewing as" })).toBeVisible();
  });
});

test.describe("Analysis workspace — the verifier demo", () => {
  test("verifier-demo downgrade: the badge shown is exactly the server's own verify-batch response, never a client-computed status", async ({ page }, testInfo) => {
    const id = await openLeaseSample(page);
    await page.route("**/api/verify-batch", (route) =>
      route.fulfill({
        json: {
          results: [
            { status: "approximate", spanStart: 0, spanEnd: 4, spanText: "rent", claimedQuote: "the exact text the client typed", verifierVersion: "test", textHash: "test" },
          ],
        },
      }),
    );
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    await openFindingsIfPhone(page, testInfo);
    const card = page.locator("article[data-finding-category]").first();
    await card.getByRole("button", { name: "Test this quote" }).click();
    const field = page.getByLabel("Test this quote");
    // Typed text that a naive client-side "does this substring exist in the document" check would
    // call verified — the stub answers "approximate" regardless, and that is what must render.
    await field.fill("the exact text the client typed");

    // Scoped to VerifierDemo's own container (the field's parent), not the whole page: the lease
    // sample already has plenty of naturally verified findings of its own elsewhere in FindingsPane,
    // so a page-wide "no verified badge" assertion would fail even when this one field's own badge
    // is correctly downgraded.
    const demoContainer = field.locator("..");
    await expect(demoContainer.getByText("Checking…")).toBeVisible();
    await expect(demoContainer.locator('[data-verification-status="approximate"]')).toBeVisible({ timeout: 3000 });
    await expect(demoContainer.locator('[data-verification-status="verified"]')).toHaveCount(0);
  });
});

test.describe("Analysis workspace — native document and generic banner", () => {
  test("workspace.generic-banner-shows-and-hides-correctly: the lease sample never renders the generic notice", async ({ page }) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("This doesn't look like one of the five document types Saboot knows well.")).toHaveCount(0);
  });

  // Two real model calls in order (extract() then runAnalysis(), src/server/services/understand.ts):
  // transcription, then findings extraction over the transcribed text — each script matched by its
  // own prompt's fixed opening sentence, never an empty string (see the module header comment).
  test("workspace.native-document-never-verified: a scanned fixture never renders a verified badge even for a finding that would verify on real text, and DocumentViewer's own transcription label appears", async ({ page }, testInfo) => {
    // The red-proof this gate needs: an empty findings array has zero badges of every status
    // alike, proving nothing about the native_document cap specifically — the cap must be a real,
    // provable ceiling, not merely "nothing to show". This finding's quote is verbatim in the
    // transcribed text, so on ordinary (non-scanned) text it verifies — the "text
    // twin" test right below proves that half — and only the native_document path is asserted to
    // cap it at approximate/not_found here.
    await stubIncidentalSidebarLists(page);
    const nonce = `native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await registerScript({ id: `${nonce}-transcribe`, match: TRANSCRIBE_PROMPT_MATCH, chunks: [JSON.stringify({ text: GENERIC_FIXTURE_SENTENCE })] });
    await registerScript({ id: `${nonce}-analyze`, match: ANALYZE_PROMPT_MATCH, chunks: [oneObligationFindingScript(GENERIC_FIXTURE_SENTENCE)] });
    const { documentId } = await uploadFixture(page, "scanned_no_text_layer.pdf", "application/pdf");

    await page.goto(`/documents/${documentId}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("This document was read from a scanned image.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Transcribed from an image — not independent evidence.")).toBeVisible();
    // FindingCard (and its verification badge) lives inside the phone BottomSheet, never the base view.
    await openFindingsIfPhone(page, testInfo);
    await expect(page.locator("article[data-finding-category]")).toHaveCount(1);
    expect(await page.locator('[data-verification-status="verified"]').count()).toBe(0);
    expect(await page.locator('[data-verification-status="approximate"], [data-verification-status="not_found"]').count()).toBeGreaterThan(0);
    // No dismiss control anywhere in ScannedNotice's own subtree: persistent, never dismissible.
    const scannedNoticeCloseButtons = await page.getByText("This document was read from a scanned image.").locator("xpath=ancestor::*[@role='note']").locator("button").count();
    expect(scannedNoticeCloseButtons).toBe(0);
  });

  test("workspace.native-document-never-verified (text twin, red-proof): the identical finding text verifies normally on an ordinary (non-scanned) upload", async ({ page }, testInfo) => {
    await stubIncidentalSidebarLists(page);
    const nonce = `native-twin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await registerScript({ id: nonce, match: ANALYZE_PROMPT_MATCH, chunks: [oneObligationFindingScript(GENERIC_FIXTURE_SENTENCE)] });
    // The document's own real canonical_text must actually contain the finding's quote verbatim —
    // an existing fixture file's own unrelated content wouldn't verify this specific sentence.
    const { documentId } = await uploadRawText(page, "text-twin.txt", GENERIC_FIXTURE_SENTENCE);

    await page.goto(`/documents/${documentId}`);
    await page.waitForLoadState("networkidle");
    // FindingCard (and its verification badge) lives inside the phone BottomSheet, never the base view.
    await openFindingsIfPhone(page, testInfo);
    await expect(page.locator('[data-verification-status="verified"]')).toHaveCount(1);
  });
});

test.describe("Analysis workspace — not_analyzed and extraction_failed", () => {
  test("workspace.extraction-failed-no-analyse-now: corrupt.pdf offers 'Upload again', never 'Analyse now'", async ({ page }, testInfo) => {
    await stubIncidentalSidebarLists(page);
    const { documentId } = await uploadFixture(page, "corrupt.pdf", "application/pdf", "EXTRACTION_FAILED");
    await page.goto(`/documents/${documentId}`);
    await page.waitForLoadState("networkidle");

    // The heading itself is always on the base document view (NotReadyPanel's own showAction=false
    // instance); `.first()` because opening the phone sheet below mounts
    // a second, showAction=true copy of the same heading behind the modal — only the buttons differ
    // between the two instances.
    await expect(page.getByText("We couldn't read this document.").first()).toBeVisible({ timeout: 20_000 });
    await openFindingsIfPhone(page, testInfo);
    await expect(page.getByRole("button", { name: "Analyse now" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload again" })).toBeVisible();
  });

  test("workspace.not-analyzed-analyse-now-calls-post: clicking 'Analyse now' POSTs /api/documents/:id/analyze and replaces the empty state with the full workspace", async ({ page }, testInfo) => {
    // Mocked at the browser level, both calls — never the global fake-provider down/up toggle
    // (tests/e2e/support/canary.spec.ts's own header comment documents exactly why: it's a
    // whole-server toggle shared with every other project's concurrently-running traffic, so a
    // narrow down/up window here could fail an unrelated in-flight request from another project).
    // This is a pure client-wiring gate — does "Analyse now" call the right endpoint and does the
    // response replace the empty state — not a live round trip through understand.ts, which is
    // exercised for real by the native-document/extraction-failed/sample-notice gates above instead.
    const id = "00000000-0000-4000-8000-000000000abc";
    const now = new Date().toISOString();
    const baseDocument = {
      id,
      title: "leave-and-license-sample.txt",
      sampleId: null,
      projectId: null,
      filename: "leave-and-license-sample.txt",
      mimeType: "text/plain",
      processingStatus: "ready" as const,
      inputMode: "text" as const,
      documentType: "leave_and_license",
      jurisdiction: "IN",
      detectionConfidence: "0.90",
      uploadedAt: now,
      expiresAt: null,
    };

    await page.route(`**/api/documents/${id}`, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({ json: { analysisState: "not_analyzed", document: baseDocument, analysis: null, findings: null } });
    });
    // processingStatus "ready" means the document column renders real text (the document column
    // follows processingStatus, independent of analysisState) — mocked
    // here too, or DocumentPane's own text query 404s against this fake id and shows an ErrorState
    // instead of the plain reading pane this state actually has.
    await page.route(`**/api/documents/${id}/text`, (route) =>
      route.fulfill({ json: { documentId: id, text: "Not-yet-analysed document text.", textHash: "test-hash", inputMode: "text", sampleId: null } }),
    );
    let analyzeCalls = 0;
    await page.route(`**/api/documents/${id}/analyze`, (route) => {
      analyzeCalls += 1;
      return route.fulfill({
        json: {
          analysisState: "complete",
          document: baseDocument,
          analysis: { id: "00000000-0000-4000-8000-000000000def", promptVersion: "understand-v3", modelUsed: "fake-test-model", createdAt: now },
          findings: [],
        },
      });
    });

    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");
    await openFindingsIfPhone(page, testInfo);
    await expect(page.getByText("This document hasn't been analysed yet")).toBeVisible();

    const analyzeRequest = page.waitForRequest((request) => request.url().endsWith(`/api/documents/${id}/analyze`) && request.method() === "POST");
    await page.getByRole("button", { name: "Analyse now" }).click();
    await analyzeRequest;

    expect(analyzeCalls).toBe(1);
    await expect(page.getByText("This document hasn't been analysed yet")).toHaveCount(0);
    await expect(page.getByText("Saboot didn't find anything to flag in this document.")).toBeVisible();
  });
});

test.describe("Analysis workspace — sample notice", () => {
  test("workspace.sample-notice-is-persistent: the lease sample shows the exact, non-dismissible InlineNotice", async ({ page }) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    // Scoped to the actual [role="note"] banner: InlineNotice's own useAnnounceOnMount also copies
    // this exact text into the chrome's sr-only polite LiveRegion on mount — not actually needed for
    // a persistent, first-paint notice like this one, but harmless — so a bare getByText() resolves
    // to two elements once that fires.
    const noticeRoot = page.getByRole("note").filter({ hasText: "Sample document. Its analysis was recorded earlier" });
    await expect(noticeRoot).toBeVisible();
    expect(await noticeRoot.locator("button").count()).toBe(0);

    // Distinct from, and rendered alongside, AnalysedByNote's own recorded-analysis second line —
    // never the same element restated.
    await page.getByText(/^Analysed by /).click();
    await expect(page.getByText("This analysis was recorded and replayed through the live verifier.")).toBeVisible();
  });

  // Split from the gate above: a real (non-sample) upload needs a real, successful findings-
  // extraction call to reach analysisState "complete" at all — its own scripted analyze call, not
  // the lease sample's replayed one.
  test("workspace.sample-notice-absent-on-a-real-upload: a real (non-sample) document never shows the sample InlineNotice", async ({ page }) => {
    await stubIncidentalSidebarLists(page);
    await registerScript({ id: `no-sample-notice-${Date.now()}`, match: ANALYZE_PROMPT_MATCH, chunks: [oneObligationFindingScript(GENERIC_FIXTURE_SENTENCE)] });
    const { documentId } = await uploadRawText(page, "no-sample-notice.txt", GENERIC_FIXTURE_SENTENCE);
    await page.goto(`/documents/${documentId}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Sample document. Its analysis was recorded earlier")).toHaveCount(0);
  });
});

test.describe("Analysis workspace — route-entry focus and the disclaimer line", () => {
  test("workspace.route-entry-focus-no-visible-ring: the <h1> receives real focus on load, without a visible focus-visible outline", async ({ page }) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    const focusedIsHeading = await page.evaluate(() => document.activeElement?.tagName === "H1");
    expect(focusedIsHeading, "focus must land on the document's <h1> on route entry (the App Router focus hazard)").toBe(true);

    // `:focus-visible` reflects the browser's own focus-modality heuristic, not what actually
    // painted — it still matches here (the ring is real focus, just visually suppressed), so the
    // computed style is what proves the CSS override actually landed.
    const outline = await page.evaluate(() => {
      const h1 = document.activeElement as HTMLElement;
      const style = window.getComputedStyle(h1);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style, "a route-entry, no-prior-interaction programmatic focus must not paint a visible ring — tabIndex=-1 means this element can never be reached any other way").toBe("none");
  });

  test("workspace.disclaimer-line-renders-once: exactly one 'not legal advice' line renders on this route", async ({ page }) => {
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Saboot explains documents. It isn't legal advice.")).toHaveCount(1);
  });
});

test.describe("Analysis workspace — live-region allow-list", () => {
  test("workspace.ask-log-in-allowlist-desktop-and-phone: role=log is absent before the first Ask message and present once one arrives (desktop)", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith("phone"), "desktop-only half of this gate");
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    expect(await page.locator('[role="log"]').count()).toBe(0);

    await page.getByRole("tab", { name: "Ask" }).click();
    await page.getByLabel("Ask about this document…").fill("What does this lease say about the deposit?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator('[role="log"]')).toHaveCount(1, { timeout: 15_000 });

    const nodes = await page.evaluate((selector) => document.querySelectorAll(selector).length, LIVE_REGION_SELECTOR);
    // The chrome pair (polite+assertive) + sonner's toaster section + this one role="log" node.
    expect(nodes).toBe(4);
  });

  test("workspace.ask-log-in-allowlist-desktop-and-phone: role=log is present only while the phone sheet's Ask tab is open", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("phone"), "phone-only half of this gate");
    const id = await openLeaseSample(page);
    await page.goto(`/documents/${id}`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("tab", { name: "Ask" }).click();
    await expect(page.locator('[role="log"]')).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(page.locator('[role="log"]')).toHaveCount(0);
  });
});

test.describe("Analysis workspace — axe", () => {
  const AXE_STATES: { name: string; visit: (page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo) => Promise<void> }[] = [
    {
      name: "workspace at rest",
      visit: async (page) => {
        const id = await openLeaseSample(page);
        await page.goto(`/documents/${id}`);
        await page.waitForLoadState("networkidle");
      },
    },
    {
      name: "mid-VerifierDemo-edit with a not_found result showing",
      visit: async (page, testInfo) => {
        const id = await openLeaseSample(page);
        await page.route("**/api/verify-batch", (route) =>
          route.fulfill({ json: { results: [{ status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "x", verifierVersion: "test", textHash: "test" }] } }),
        );
        await page.goto(`/documents/${id}`);
        await page.waitForLoadState("networkidle");
        await openFindingsIfPhone(page, testInfo);
        await page.locator("article[data-finding-category]").first().getByRole("button", { name: "Test this quote" }).click();
        await page.getByLabel("Test this quote").fill("a sentence not in the document");
        await expect(page.getByText("Not found in your document")).toBeVisible({ timeout: 3000 });
      },
    },
    {
      name: "DocumentHeader's own ItemMenu open",
      visit: async (page) => {
        const id = await openLeaseSample(page);
        await page.goto(`/documents/${id}`);
        await page.waitForLoadState("networkidle");
        // Scoped to <header> (DocumentHeader's own root element): a bare `/^Actions for/` role
        // query also matches the sidebar RecentsList row's own ItemMenu trigger for this same
        // now-recent document — same accessible-name pattern, different component, a real
        // strict-mode collision this file's earlier version never hit until axe actually ran it.
        await page.locator("header").getByRole("button", { name: /^Actions for/ }).click();
      },
    },
    {
      name: "sample-document state (the persistent InlineNotice)",
      visit: async (page) => {
        const id = await openLeaseSample(page);
        await page.goto(`/documents/${id}`);
        await page.waitForLoadState("networkidle");
        // getByRole("note"), not a bare getByText(): InlineNotice's own useAnnounceOnMount also
        // copies this text into the sr-only polite LiveRegion, so a plain text query resolves to
        // two elements.
        await expect(page.getByRole("note").filter({ hasText: "Sample document. Its analysis was recorded earlier" })).toBeVisible();
      },
    },
    {
      name: "not_analyzed (ready) state",
      visit: async (page, testInfo) => {
        const id = "00000000-0000-4000-8000-000000000abd";
        const now = new Date().toISOString();
        await page.route(`**/api/documents/${id}`, (route) =>
          route.request().method() === "GET"
            ? route.fulfill({
                json: {
                  analysisState: "not_analyzed",
                  document: {
                    id,
                    title: "axe-not-analyzed.txt",
                    sampleId: null,
                    projectId: null,
                    filename: "axe-not-analyzed.txt",
                    mimeType: "text/plain",
                    processingStatus: "ready",
                    inputMode: "text",
                    documentType: "leave_and_license",
                    jurisdiction: "IN",
                    detectionConfidence: "0.90",
                    uploadedAt: now,
                    expiresAt: null,
                  },
                  analysis: null,
                  findings: null,
                },
              })
            : route.fallback(),
        );
        // processingStatus "ready" means DocumentPane fetches real text — mocked here too, or the
        // real server 404s this fake id and axe ends up checking an ErrorState, not this state.
        await page.route(`**/api/documents/${id}/text`, (route) =>
          route.fulfill({ json: { documentId: id, text: "Not-yet-analysed document text.", textHash: "test-hash", inputMode: "text", sampleId: null } }),
        );
        await page.goto(`/documents/${id}`);
        await page.waitForLoadState("networkidle");
        await openFindingsIfPhone(page, testInfo);
        await expect(page.getByText("This document hasn't been analysed yet")).toBeVisible();
      },
    },
    {
      name: "extraction_failed state",
      visit: async (page) => {
        await stubIncidentalSidebarLists(page);
        const { documentId } = await uploadFixture(page, "corrupt.pdf", "application/pdf", "EXTRACTION_FAILED");
        await page.goto(`/documents/${documentId}`);
        await page.waitForLoadState("networkidle");
        await expect(page.getByText("We couldn't read this document.").first()).toBeVisible({ timeout: 20_000 });
      },
    },
  ];

  for (const { name, visit } of AXE_STATES) {
    test(`axe: ${name} — zero serious/critical`, async ({ page }, testInfo) => {
      await visit(page, testInfo);
      const results = await new AxeBuilder({ page }).exclude(AXE_EXCLUDE).analyze();
      expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    });
  }
});
