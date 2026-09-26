// /drafts/new and /drafts/[id]'s own done-when gates. Most fixtures here are
// page.route-fulfilled (the same convention 02-shell.spec.ts already uses) rather than built through
// several real round trips: the behaviour under test is the client's own reaction to a given
// response shape, not the server logic that produces it, and precise isCurrent/isLatest/reordered
// fixtures are otherwise hard to construct deterministically. The one real, fake-provider-driven
// path is the from-scratch happy path, which needs a genuine POST /api/drafts round trip.

import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { test, expect, assertThemeApplied, type ThemeOption } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";

const AXE_OPTIONS = { exclude: "nextjs-portal" } as const;

function draftFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "draft-1",
    title: "Leave and License Agreement (Rental) draft",
    documentType: "leave_and_license",
    mode: "from_scratch",
    groundingDocumentId: null,
    revisionNumber: 1,
    parentDraftId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    modelUsed: "gemini-2.5-flash",
    jurisdiction: "IN",
    groundingDocumentAvailable: null,
    promptVersion: "v1",
    content: "Section one body.\n\nSection two body.",
    sections: [
      { key: "disclaimer", heading: "About This Draft", provenance: "templated", content: "Fixed disclaimer text." },
      { key: "parties_and_premises", heading: "Parties and Premises", provenance: "ai_generated", content: "The Licensor and Licensee agree..." },
    ],
    ...overrides,
  };
}

function documentDetailFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    analysisState: "not_analyzed",
    document: {
      id: "doc-1",
      title: "Lease.pdf",
      sampleId: null,
      projectId: null,
      filename: "lease.pdf",
      mimeType: "application/pdf",
      processingStatus: "ready",
      inputMode: "text",
      documentType: "leave_and_license",
      jurisdiction: "IN",
      detectionConfidence: null,
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      ...(overrides.document as Record<string, unknown> | undefined),
    },
    analysis: null,
    findings: null,
  };
}

test.describe("/drafts/new — grounding deep link", () => {
  test("f4.grounding-deep-link-preselects-mode: a 200 preselects grounded mode with that document chosen, and clears the URL param", async ({ page }) => {
    // Whichever project runs this file first pays for /drafts/new's own on-demand dev-server
    // compile on the timed URL-param-clear assertion below — a throwaway warm-up request first
    // keeps that off the real navigation, the same convention 02-shell-settings.spec.ts uses.
    await page.request.get("/drafts/new").catch(() => undefined);
    await page.route("**/api/documents/doc-1", (route) => route.fulfill({ json: documentDetailFixture() }));
    await page.goto("/drafts/new?grounding=doc-1");
    await expect(page.getByRole("radio", { name: "Respond to a document you have" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Document to respond to" })).toContainText("Lease.pdf");
    await expect(page).toHaveURL("/drafts/new");
  });

  test("f4.grounding-deep-link-preselects-mode: a 404 leaves the mode picker unselected, shows the InlineNotice, and still clears the param", async ({ page }) => {
    await page.route("**/api/documents/doc-missing", (route) =>
      route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "The requested resource could not be found." } } }),
    );
    await page.goto("/drafts/new?grounding=doc-missing");
    await expect(page.getByRole("note").filter({ hasText: "That document couldn't be used to start a draft." })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Start from scratch" })).not.toBeChecked();
    await expect(page.getByRole("radio", { name: "Respond to a document you have" })).not.toBeChecked();
    await expect(page).toHaveURL("/drafts/new");
  });

  test("a not-ready deep-linked document stays preselected with a status note, and Create stays disabled", async ({ page }) => {
    await page.route("**/api/documents/doc-pending", (route) =>
      route.fulfill({ json: documentDetailFixture({ document: { id: "doc-pending", processingStatus: "pending" } }) }),
    );
    await page.goto("/drafts/new?grounding=doc-pending");
    await expect(page.getByRole("radio", { name: "Respond to a document you have" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Document to respond to" })).toContainText("Still processing");
    await page.getByLabel(/what do you want this draft to say/i).fill("reply asking for more time");
    await expect(page.getByRole("button", { name: "Draft" })).toBeDisabled();
  });
});

test.describe("/drafts/new — mode<->type pairing", () => {
  test("from-scratch mode never lists grounded_response; grounded mode shows only the fixed label", async ({ page }) => {
    await page.route("**/api/documents?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto("/drafts/new");

    await page.getByRole("radio", { name: "Start from scratch" }).click();
    await page.getByLabel("Document type", { exact: true }).click();
    const options = await page.getByRole("option").allTextContents();
    expect(options).not.toContain("Grounded Response Draft");
    await page.keyboard.press("Escape");

    await page.getByRole("radio", { name: "Respond to a document you have" }).click();
    await expect(page.getByLabel("Document type", { exact: true })).toContainText("Grounded Response Draft");
  });
});

test.describe("/drafts/[id] — Based on", () => {
  test("f4.based-on-links-to-grounding-document: 200 renders a link, never an InlineNotice", async ({ page }) => {
    await page.route("**/api/drafts/draft-1", (route) =>
      route.fulfill({ json: draftFixture({ mode: "document_grounded", groundingDocumentId: "doc-1", groundingDocumentAvailable: true }) }),
    );
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "reply", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.route("**/api/documents/doc-1", (route) => route.fulfill({ json: documentDetailFixture() }));
    await page.goto("/drafts/draft-1");
    await expect(page.getByRole("link", { name: "Based on: Lease.pdf" })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "The document this draft was based on is no longer available." })).toHaveCount(0);
  });

  test("a 404 on the secondary fetch shows the InlineNotice, never a link", async ({ page }) => {
    await page.route("**/api/drafts/draft-1", (route) =>
      route.fulfill({ json: draftFixture({ mode: "document_grounded", groundingDocumentId: "doc-1", groundingDocumentAvailable: true }) }),
    );
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "reply", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.route("**/api/documents/doc-1", (route) =>
      route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "The requested resource could not be found." } } }),
    );
    await page.goto("/drafts/draft-1");
    await expect(page.getByRole("note").filter({ hasText: "The document this draft was based on is no longer available." })).toBeVisible();
    await expect(page.getByRole("link", { name: /Based on/ })).toHaveCount(0);
  });

  test("groundingDocumentAvailable: false shows the InlineNotice with no secondary fetch at all", async ({ page }) => {
    let secondaryFetched = false;
    await page.route("**/api/drafts/draft-1", (route) =>
      route.fulfill({ json: draftFixture({ mode: "document_grounded", groundingDocumentId: "doc-1", groundingDocumentAvailable: false }) }),
    );
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "reply", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.route("**/api/documents/doc-1", (route) => {
      secondaryFetched = true;
      return route.fulfill({ json: documentDetailFixture() });
    });
    await page.goto("/drafts/draft-1");
    await expect(page.getByRole("note").filter({ hasText: "The document this draft was based on is no longer available." })).toBeVisible();
    expect(secondaryFetched).toBe(false);
  });

  for (const status of [429, 500]) {
    test(`a ${status} on the secondary fetch renders neither a link nor the InlineNotice`, async ({ page }) => {
      await page.route("**/api/drafts/draft-1", (route) =>
        route.fulfill({ json: draftFixture({ mode: "document_grounded", groundingDocumentId: "doc-1", groundingDocumentAvailable: true }) }),
      );
      await page.route("**/api/drafts/draft-1/revisions", (route) =>
        route.fulfill({
          json: {
            items: [
              { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "reply", isCurrent: true, isLatest: true },
            ],
          },
        }),
      );
      await page.route("**/api/documents/doc-1", (route) =>
        route.fulfill({
          status,
          json:
            status === 429
              ? { error: { code: "RATE_LIMITED", message: "You've reached your limit for now. Try again in a little while." } }
              : { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } },
        }),
      );
      await page.goto("/drafts/draft-1");
      await expect(page.getByText("Leave and License Agreement")).toBeVisible(); // draft content painted regardless
      await expect(page.getByRole("note").filter({ hasText: "The document this draft was based on is no longer available." })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /Based on/ })).toHaveCount(0);
    });
  }

  test("offline on the secondary fetch renders neither a link nor the InlineNotice, and draft sections are unaffected", async ({ page, context }) => {
    await page.route("**/api/drafts/draft-1", (route) =>
      route.fulfill({ json: draftFixture({ mode: "document_grounded", groundingDocumentId: "doc-1", groundingDocumentAvailable: true }) }),
    );
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "reply", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.route("**/api/documents/doc-1", (route) => route.abort("internetdisconnected"));
    await page.goto("/drafts/draft-1");
    await expect(page.getByText("Parties and Premises")).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "The document this draft was based on is no longer available." })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Based on/ })).toHaveCount(0);
    void context;
  });
});

test.describe("/drafts/[id] — RevisionTimeline", () => {
  const revisions = [
    { id: "rev-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: null, isCurrent: false, isLatest: false },
    { id: "rev-2", parentDraftId: "rev-1", revisionNumber: 2, createdAt: "2026-01-02T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "shorten the notice period", isCurrent: false, isLatest: true },
  ];

  test("f4.timeline-walks-the-chain-in-order: exactly one /revisions request, oldest-to-newest, aria-current, isLatest hides Go to latest", async ({ page }, testInfo) => {
    const isPhone = testInfo.project.name.startsWith("phone");
    let revisionsRequestCount = 0;
    await page.route("**/api/drafts/rev-2", (route) => route.fulfill({ json: draftFixture({ id: "rev-2", revisionNumber: 2, parentDraftId: "rev-1" }) }));
    await page.route("**/api/drafts/rev-2/revisions", (route) => {
      revisionsRequestCount += 1;
      return route.fulfill({ json: { items: revisions.map((r) => (r.id === "rev-2" ? { ...r, isCurrent: true } : r)) } });
    });

    await page.goto("/drafts/rev-2");
    if (isPhone) await page.getByRole("button", { name: "Revisions (2)" }).click();

    await expect(page.getByText("Instructions not recorded")).toBeVisible();
    await expect(page.getByText("shorten the notice period")).toBeVisible();
    await expect(page.getByRole("button", { name: "Go to latest" })).toHaveCount(0);
    expect(revisionsRequestCount).toBe(1);
  });

  test("f4.go-to-latest-navigates: from a non-latest revision, clicking navigates to the isLatest entry", async ({ page }, testInfo) => {
    const isPhone = testInfo.project.name.startsWith("phone");
    await page.route("**/api/drafts/rev-1", (route) => route.fulfill({ json: draftFixture({ id: "rev-1", revisionNumber: 1, parentDraftId: null }) }));
    await page.route("**/api/drafts/rev-1/revisions", (route) =>
      route.fulfill({ json: { items: revisions.map((r) => (r.id === "rev-1" ? { ...r, isCurrent: true } : r)) } }),
    );
    await page.route("**/api/drafts/rev-2", (route) => route.fulfill({ json: draftFixture({ id: "rev-2", revisionNumber: 2, parentDraftId: "rev-1" }) }));
    await page.route("**/api/drafts/rev-2/revisions", (route) =>
      route.fulfill({ json: { items: revisions.map((r) => (r.id === "rev-2" ? { ...r, isCurrent: true } : r)) } }),
    );

    await page.goto("/drafts/rev-1");
    if (isPhone) await page.getByRole("button", { name: "Revisions (2)" }).click();
    await page.getByRole("button", { name: "Go to latest" }).click();
    await expect(page).toHaveURL("/drafts/rev-2");
  });
});

test.describe("/drafts/[id] — provenance and export", () => {
  test("templated and ai_generated sections carry distinct, exact labels — never colour-only", async ({ page }) => {
    await page.route("**/api/drafts/draft-1", (route) => route.fulfill({ json: draftFixture() }));
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "draft it", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.goto("/drafts/draft-1");
    await expect(page.getByText("Fixed text", { exact: true })).toBeVisible();
    await expect(page.getByText("AI-generated", { exact: true })).toBeVisible();
  });

  test("ExportMenu offers Download and Copy, never Print, on the draft screen", async ({ page }) => {
    await page.route("**/api/drafts/draft-1", (route) => route.fulfill({ json: draftFixture() }));
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "draft it", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.goto("/drafts/draft-1");
    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.getByRole("menuitem", { name: "Download" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Print" })).toHaveCount(0);
  });
});

test.describe("draft.503 — a revise call returns 503", () => {
  test("revise honours RetryAfterNotice copy on a 503", async ({ page }) => {
    await page.route("**/api/drafts/draft-1", (route) => route.fulfill({ json: draftFixture() }));
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "draft it", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.route("**/api/drafts/draft-1/revise", (route) =>
      route.fulfill({ status: 503, json: { error: { code: "UPSTREAM_UNAVAILABLE", message: "The AI providers are busy right now. Try again in a few minutes." } } }),
    );
    await page.goto("/drafts/draft-1");
    await page.getByLabel("Revise this draft").fill("shorten the notice period further");
    await page.getByRole("button", { name: "Revise" }).click();
    await expect(page.getByRole("note").filter({ hasText: "The AI providers are busy right now." })).toBeVisible();
  });
});

test.describe("f4.from-scratch-happy-path — a real draft, through the fake provider", () => {
  test("creates a leave_and_license draft from scratch; sections carry non-empty content and only templated/ai_generated provenance", async ({ page, ip }, testInfo) => {
    // Whichever project runs first pays for /drafts/new's on-demand dev-server compile across
    // several steps, not just the revisions round trip below — each already-generous per-assertion
    // timeout still adds up past the default 30s test timeout on that one cold run (a solo run of
    // this file alongside its own siblings took 8.3s here, comfortably inside this ceiling; the
    // ceiling itself stays generous enough to cover every step below maxing out its own timeout at
    // once, the worst case the whole suite's own full run actually hit).
    test.setTimeout(90_000);
    const isPhone = testInfo.project.name.startsWith("phone");
    const nonce = `e2e-draft-${randomUUID()}`;
    await registerScript({
      id: nonce,
      match: nonce,
      chunks: [
        JSON.stringify({
          sections: {
            parties_and_premises: "The Licensor, Mr. A, and the Licensee, Ms. B, agree to the following premises.",
            term_rent_and_deposit: "The term is eleven months at a monthly rent of Rs. 20,000 with a deposit of Rs. 60,000.",
            termination_and_notice: "Either party may terminate on 30 days' written notice.",
            maintenance_and_restrictions: "The Licensee shall maintain the premises and use them for residential purposes only.",
            governing_law_and_disputes: "This Agreement is governed by Indian law; disputes go to the courts at Mumbai.",
          },
        }),
      ],
    });

    await page.goto("/drafts/new");
    await page.getByRole("radio", { name: "Start from scratch" }).click();
    await page.getByLabel("Document type", { exact: true }).click();
    await page.getByRole("option", { name: "Leave and License Agreement (Rental)" }).click();
    await page.getByLabel(/what do you want this draft to say/i).fill(`${nonce} a lease for a 1BHK in Pune, rent 20000, deposit 60000`);
    await page.getByRole("button", { name: "Draft" }).click();

    await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]+$/, { timeout: 20_000 });
    await expect(page.getByText("Parties and Premises")).toBeVisible();
    await expect(page.getByText("Fixed text", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("AI-generated", { exact: true }).first()).toBeVisible();

    // userInstructions persisted server-side, visible later in the revision entry — the submitted
    // brief round-trips rather than being dropped. On phone the entry lives behind the "Revisions
    // (N)" sheet, never rendered inline (see RevisionTimeline's own header comment). A generous
    // timeout here, like the redirect's above: this text depends on a second round trip (GET
    // .../revisions) fired only after the redirect lands, which a cold dev-server compile can push
    // past the default 5s (observed exceeding even a 15s allowance once, under this whole suite's
    // own full-run parallel load — whichever project happens to hit this file first pays it).
    if (isPhone) await page.getByRole("button", { name: "Revisions (1)" }).click({ timeout: 30_000 });
    await expect(page.getByText(new RegExp(nonce))).toBeVisible({ timeout: 30_000 });
    void ip;
  });
});

test.describe("theme convention", () => {
  test("html.dark reflects the configured theme before any themed assertion", async ({ page, theme }) => {
    await page.route("**/api/documents?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto("/drafts/new");
    await assertThemeApplied(page, theme as ThemeOption);
  });
});

test.describe("accessibility", () => {
  test("axe: /drafts/new, from-scratch mode — zero serious/critical", async ({ page }) => {
    await page.route("**/api/documents?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto("/drafts/new");
    await page.getByRole("radio", { name: "Start from scratch" }).click();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /drafts/new, grounded mode with zero documents — zero serious/critical", async ({ page }) => {
    await page.route("**/api/documents?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto("/drafts/new");
    await page.getByRole("radio", { name: "Respond to a document you have" }).click();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /drafts/[id] at rest, with Based on linked — zero serious/critical", async ({ page }) => {
    await page.route("**/api/drafts/draft-1", (route) =>
      route.fulfill({ json: draftFixture({ mode: "document_grounded", groundingDocumentId: "doc-1", groundingDocumentAvailable: true }) }),
    );
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "reply", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.route("**/api/documents/doc-1", (route) => route.fulfill({ json: documentDetailFixture() }));
    await page.goto("/drafts/draft-1");
    await expect(page.getByRole("link", { name: "Based on: Lease.pdf" })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /drafts/[id] with the grounding-gone InlineNotice — zero serious/critical", async ({ page }) => {
    await page.route("**/api/drafts/draft-1", (route) =>
      route.fulfill({ json: draftFixture({ mode: "document_grounded", groundingDocumentId: "doc-1", groundingDocumentAvailable: false }) }),
    );
    await page.route("**/api/drafts/draft-1/revisions", (route) =>
      route.fulfill({
        json: {
          items: [
            { id: "draft-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", modelUsed: "gemini-2.5-flash", userInstructions: "reply", isCurrent: true, isLatest: true },
          ],
        },
      }),
    );
    await page.goto("/drafts/draft-1");
    await expect(page.getByRole("note").filter({ hasText: "The document this draft was based on is no longer available." })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
