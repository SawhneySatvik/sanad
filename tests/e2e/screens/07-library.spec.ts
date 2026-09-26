// /library's own done-when gates. Comparisons/drafts/threads' own real round trips would need a
// live model call (compare/draft creation); the fake provider has scripted coverage for a
// from-scratch draft (see tests/e2e/screens/06-draft.spec.ts's own from-scratch-happy-path test) but
// not yet for an arbitrary compare pair. Every gate below that doesn't need a real document instead
// drives the client's own reaction to a given response shape via page.route, the same convention
// 02-shell.spec.ts and 06-draft.spec.ts already use.

import AxeBuilder from "@axe-core/playwright";
import { test, expect, assertThemeApplied, type ThemeOption } from "../support/fixtures";

const AXE_OPTIONS = { exclude: "nextjs-portal" } as const;

function emptyList() {
  return { items: [], nextCursor: null };
}

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1", title: "Lease.pdf", filename: "lease.pdf", documentType: "leave_and_license",
    processingStatus: "ready", analysisState: "complete", inputMode: "text", sampleId: null,
    projectId: null, uploadedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", expiresAt: null,
    ...overrides,
  };
}

function comparisonRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp-1", title: "Lease v1 vs Lease v2", titleA: "Lease v1", titleB: "Lease v2",
    documentAId: "doc-a", documentBId: "doc-b", modelUsed: "gemini", projectId: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", expiresAt: null,
    ...overrides,
  };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1", title: "NDA draft", documentType: "nda", mode: "from_scratch", revisionCount: 3,
    projectId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T12:00:00.000Z", expiresAt: null,
    ...overrides,
  };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1", title: "Server thread", projectId: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T06:00:00.000Z",
    ...overrides,
  };
}

async function fulfillLists(
  page: import("@playwright/test").Page,
  lists: { documents?: object[]; comparisons?: object[]; drafts?: object[]; threads?: object[] },
) {
  await page.route("**/api/documents?**", (route) => route.fulfill({ json: { items: lists.documents ?? [], nextCursor: null } }));
  await page.route("**/api/comparisons?**", (route) => route.fulfill({ json: { items: lists.comparisons ?? [], nextCursor: null } }));
  await page.route("**/api/drafts?**", (route) => route.fulfill({ json: { items: lists.drafts ?? [], nextCursor: null } }));
  await page.route("**/api/threads?**", (route) => route.fulfill({ json: { items: lists.threads ?? [], nextCursor: null } }));
}

test.describe("/library — the All tab merges every kind", () => {
  test("library.all-tab-merges-four-lists: server rows plus a local thread all appear, each linking to its own route", async ({ page }) => {
    await fulfillLists(page, {
      documents: [documentRow()],
      comparisons: [comparisonRow()],
      drafts: [draftRow()],
      threads: [threadRow()],
    });
    await page.addInitScript(() => {
      window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-e2e-lib"]));
      window.localStorage.setItem(
        "saboot:threads:v1:local-e2e-lib",
        JSON.stringify({ id: "local-e2e-lib", title: "Local chat", documentIds: [], messages: [] }),
      );
    });

    await page.goto("/library");
    // Scoped to the main content region: the sidebar's own RecentsList reads the exact same list
    // keys and would otherwise render a second, identically-named link for every row.
    const main = page.locator("#main-content");
    await expect(main.getByRole("link", { name: "Lease.pdf" })).toHaveAttribute("href", "/documents/doc-1");
    await expect(main.getByRole("link", { name: "Lease v1 vs Lease v2" })).toHaveAttribute("href", "/compare/cmp-1");
    await expect(main.getByRole("link", { name: "NDA draft" })).toHaveAttribute("href", "/drafts/draft-1");
    await expect(main.getByRole("link", { name: "Server thread" })).toHaveAttribute("href", "/chat/thread-1");
    await expect(main.getByRole("link", { name: "Local chat" })).toHaveAttribute("href", "/chat/local-e2e-lib");
  });
});

test.describe("/library — rename", () => {
  test("library.rename-blocks-over-cap-client-side-no-network-call", async ({ page }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    let patchCalled = false;
    await page.route("**/api/documents/doc-1", (route) => {
      if (route.request().method() === "PATCH") patchCalled = true;
      return route.continue();
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Actions for Lease.pdf" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    // exact: true — "Rename document" (the dialog's own accessible name, via aria-labelledby) is a
    // substring match for "Name" too, otherwise ambiguous with the actual field.
    const field = await page.getByLabel("Name", { exact: true });
    await field.fill("x".repeat(121));
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(patchCalled).toBe(false);
  });

  test("library.rename-uses-the-servers-response-not-the-raw-input", async ({ page }) => {
    // A stateful list mock, not fulfillLists' fixed one: handleRename's own optimistic cache write
    // races a void invalidateQueries() it fires right after, and a static list route would win that
    // race with the pre-rename title once the refetch it triggers lands — a real backend's list
    // read reflects the rename it just persisted, same as this one now does.
    let title = "Lease.pdf";
    await page.route("**/api/documents?**", (route) => route.fulfill({ json: { items: [documentRow({ title })], nextCursor: null } }));
    await page.route("**/api/comparisons?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.route("**/api/drafts?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.route("**/api/threads?**", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.route("**/api/documents/doc-1", (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      title = "Lease";
      return route.fulfill({ json: documentRow({ title }) });
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Actions for Lease.pdf" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const field = await page.getByLabel("Name", { exact: true });
    await field.fill("  Lease  ");
    await page.getByRole("button", { name: "Save" }).click();
    // The server's own echoed value ("Lease"), never the raw "  Lease  " the client submitted.
    await expect(page.getByRole("link", { name: "Lease", exact: true })).toBeVisible();
  });
});

test.describe("/library — delete", () => {
  test("library.delete-impact-shown-before-confirm: exact singular/plural copy from a real impact response", async ({ page }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    await page.route("**/api/documents/doc-1/delete-impact", (route) =>
      route.fulfill({ json: { comparisons: 2, draftsUngrounded: 1, threadsUnlinked: 1 } }),
    );
    await page.goto("/library");
    await page.getByRole("button", { name: "Actions for Lease.pdf" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByText("2 comparisons will also be deleted.")).toBeVisible();
    await expect(page.getByText("1 draft will lose its grounding document.")).toBeVisible();
    await expect(page.getByText("1 saved chat will lose this document as a source.")).toBeVisible();
    await expect(page.getByText("Chats on this device that quote it will show it as unavailable.")).toBeVisible();
  });

  test("library.comparison-delete-uses-fixed-copy-no-network-call", async ({ page }) => {
    await fulfillLists(page, { comparisons: [comparisonRow()] });
    let impactCalled = false;
    await page.route("**/delete-impact", () => {
      impactCalled = true;
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /Actions for Lease v1 vs Lease v2/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByText("Delete this comparison? Changes cascade. The two documents are untouched.")).toBeVisible();
    expect(impactCalled).toBe(false);
  });

  test("library.draft-delete-states-all-n-revisions", async ({ page }) => {
    await fulfillLists(page, { drafts: [draftRow({ revisionCount: 3 })] });
    await page.goto("/library");
    await page.getByRole("button", { name: "Actions for NDA draft" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByText("Delete this draft? All 3 revisions will be deleted.")).toBeVisible();
  });
});

test.describe("/library — partial failure and offline", () => {
  test("library.partial-list-failure-does-not-blank-page", async ({ page }) => {
    await page.route("**/api/documents?**", (route) => route.fulfill({ json: { items: [documentRow()], nextCursor: null } }));
    await page.route("**/api/drafts?**", (route) => route.fulfill({ json: emptyList() }));
    await page.route("**/api/threads?**", (route) => route.fulfill({ json: emptyList() }));
    await page.route("**/api/comparisons?**", (route) =>
      route.fulfill({
        status: 429,
        headers: { "retry-after": "30" },
        json: { error: { code: "RATE_LIMITED", message: "You've reached your limit for now. Try again in 30 seconds." } },
      }),
    );
    await page.goto("/library");
    await expect(page.getByRole("link", { name: "Lease.pdf" })).toBeVisible();
    // .first(): RetryAfterNotice's own useAnnounceOnMount copies this exact text into the sr-only
    // assertive LiveRegion too, so a plain text query resolves to two elements.
    await expect(page.getByText(/Try again in 30 seconds/).first()).toBeVisible();
  });

  test("library.offline-disables-nothing-destructive", async ({ page, context }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    await page.goto("/library");
    await expect(page.getByRole("link", { name: "Lease.pdf" })).toBeVisible();
    await context.setOffline(true);
    // OfflineBanner is an Alert with role="note" — filtered by role rather than a bare getByText,
    // which also matches its own mirrored copy in the sr-only LiveRegion.
    await expect(page.getByRole("note").filter({ hasText: "You're offline. Saboot needs a connection to read and answer." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Lease.pdf" })).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe("/library — empty states", () => {
  test("all four lists empty shows the illustrated empty state with a Start a chat CTA", async ({ page }) => {
    await fulfillLists(page, {});
    await page.goto("/library");
    // getByRole("heading", ...), not a bare getByText: the sidebar's own RecentsList carries the
    // identical "Nothing here yet" copy for its own empty state, a real second match whenever
    // Recents happens to be empty too.
    await expect(page.getByRole("heading", { name: "Nothing here yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a chat" })).toBeVisible();
  });

  test("a single empty tab shows its own copy while others may still have rows", async ({ page }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    await page.goto("/library");
    await page.getByRole("tab", { name: "Comparisons" }).click();
    await expect(page.getByText("No comparisons yet")).toBeVisible();
  });
});

test.describe("theme convention", () => {
  test("html.dark reflects the configured theme before any themed assertion", async ({ page, theme }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    await page.goto("/library");
    await assertThemeApplied(page, theme as ThemeOption);
  });
});

test.describe("accessibility", () => {
  test("axe: /library populated All tab — zero serious/critical", async ({ page }) => {
    await fulfillLists(page, { documents: [documentRow()], comparisons: [comparisonRow()], drafts: [draftRow()], threads: [threadRow()] });
    await page.goto("/library");
    await expect(page.getByRole("link", { name: "Lease.pdf" })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /library empty state — zero serious/critical", async ({ page }) => {
    await fulfillLists(page, {});
    await page.goto("/library");
    // getByRole("heading", ...): see the same-copy comment above, in the empty-states describe block.
    await expect(page.getByRole("heading", { name: "Nothing here yet" })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /library ItemMenu open — zero serious/critical", async ({ page }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    await page.goto("/library");
    await page.getByRole("button", { name: "Actions for Lease.pdf" }).click();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /library ConfirmDeleteDialog open (document, with impact) — zero serious/critical", async ({ page }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    await page.route("**/api/documents/doc-1/delete-impact", (route) => route.fulfill({ json: { comparisons: 1, draftsUngrounded: 0, threadsUnlinked: 0 } }));
    await page.goto("/library");
    await page.getByRole("button", { name: "Actions for Lease.pdf" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByText("1 comparison will also be deleted.")).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: /library RenameDialog open — zero serious/critical", async ({ page }) => {
    await fulfillLists(page, { documents: [documentRow()] });
    await page.goto("/library");
    await page.getByRole("button", { name: "Actions for Lease.pdf" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const results = await new AxeBuilder({ page }).exclude(AXE_OPTIONS.exclude).analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
