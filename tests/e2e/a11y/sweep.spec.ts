// The whole-app axe sweep: every named route/state, on desktop-light, desktop-dark and phone-light
// (phone-dark is skipped everywhere — the ticket's own matrix). Zero serious/critical axe violations,
// exactly one <h1>, exactly one main landmark, and a skip link that targets it, on every one. Tagged
// @a11y so `npm run test:a11y` (playwright test --grep @a11y) picks this up; also part of the
// ordinary tests/e2e/a11y tree test:e2e already runs.

import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, assertThemeApplied } from "../support/fixtures";
import { registerScript } from "../support/fake-provider/client";
import { isPhoneProject, openLeaseSample, uploadRawText } from "../flows/_shared";

const AXE_EXCLUDE = "nextjs-portal";
const ABOUT_TO_SIGN_MATCH = "This reader has not signed yet";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function assertSingleMainAndSkipLink(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }), "exactly one h1").toHaveCount(1);
  await expect(page.getByRole("main"), "exactly one main landmark").toHaveCount(1);

  const skipLink = page.getByRole("link", { name: /skip to main content/i });
  await expect(skipLink, "a skip link targeting main content").toHaveCount(1);
  const href = await skipLink.getAttribute("href");
  expect(href, "the skip link is a same-page fragment link").toMatch(/^#/);
  const targetId = href!.slice(1);
  const targetIsMainOrInside = await page.evaluate((id) => {
    const target = document.getElementById(id);
    if (!target) return false;
    const main = document.querySelector("main");
    return target === main || (main?.contains(target) ?? false);
  }, targetId);
  expect(targetIsMainOrInside, `the skip link's target (#${targetId}) is main or inside it`).toBe(true);
}

interface SweepState {
  name: string;
  /** Only reachable on a phone project — the desktop layout has no equivalent surface. */
  phoneOnly?: boolean;
  /**
   * A focus-trapped modal/sheet state: Radix correctly aria-hides the rest of the page (its own
   * h1, main and skip link included) while one is open, and HTML permits only one non-hidden
   * <main> — asserting a second one here would demand invalid markup to satisfy a literal reading
   * of "one h1/one main/one skip link" that a modal was never meant to hold. The state's own setup
   * asserts the underlying page held that trio before opening, and the loop checks the dialog's own
   * accessible name plus axe instead of re-running the page-level structural check against it.
   */
  overlay?: boolean;
  setup: (page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo) => Promise<void>;
}

const STATES: SweepState[] = [
  {
    name: "landing",
    setup: async (page) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "/chat home",
    setup: async (page) => {
      await page.goto("/chat");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "chat thread",
    setup: async (page) => {
      await page.route("**/api/ask", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sseFrame("final", {
            type: "final",
            message: {
              id: null,
              role: "assistant",
              content: "General information about your question.",
              provenance: "ai_generated",
              modelUsed: "gemini-2.5-flash",
              routedDomains: ["general_legal"],
              createdAt: null,
              mode: "general",
              redirect: false,
              label: "General information, not verified against a document.",
            },
          }),
        }),
      );
      await page.goto("/chat");
      await page.waitForLoadState("networkidle");
      await page.getByLabel("Ask Saboot").fill("What should I know about a lease?");
      await page.getByLabel("Ask Saboot").press("Enter");
      await expect(page.getByText("General information about your question.")).toBeVisible();
    },
  },
  {
    name: "workspace (default)",
    setup: async (page) => {
      const documentId = await openLeaseSample(page);
      await page.goto(`/documents/${documentId}`);
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "workspace (finding-selected)",
    setup: async (page, testInfo) => {
      const documentId = await openLeaseSample(page);
      await page.goto(`/documents/${documentId}`);
      await page.waitForLoadState("networkidle");
      if (isPhoneProject(testInfo)) {
        await page.getByRole("button", { name: /^\d+ findings?$/ }).click();
        await page.getByRole("dialog").waitFor();
      }
      await page
        .getByRole("button", { name: /^Show .+ in document$/ })
        .first()
        .click();
      await page.locator("mark[data-active]").waitFor({ timeout: 5000 });
    },
  },
  {
    name: "phone findings sheet",
    phoneOnly: true,
    overlay: true,
    setup: async (page) => {
      const documentId = await openLeaseSample(page);
      await page.goto(`/documents/${documentId}`);
      await page.waitForLoadState("networkidle");
      // The underlying page's own structural trio, checked before the sheet ever opens — the sheet
      // itself is asserted differently below (see the overlay flag's own comment).
      await assertSingleMainAndSkipLink(page);
      await page.getByRole("button", { name: /^\d+ findings?$/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await expect(dialog).toHaveAccessibleName("Findings and Ask");
    },
  },
  {
    name: "compare picker",
    setup: async (page) => {
      await page.goto("/compare");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "compare view",
    setup: async (page, testInfo) => {
      const nonce = `e2e-sweep-compare-${randomUUID()}`;
      // Matched by the nonce alone (both uploads' own text below), never the shared fixed
      // system-prompt sentence — see F2/F3/F8's own flow specs for why. Registered once, then
      // overwritten in place (same id) for the compare call — both uploads' own analyze calls have
      // already resolved by then.
      await registerScript({ id: nonce, match: nonce, chunks: [JSON.stringify({ findings: [] })] });
      const titleA = `${nonce}-a.txt`;
      const titleB = `${nonce}-b.txt`;
      await uploadRawText(page, titleA, `The monthly amount is Rs. 10,000. (ref: ${nonce})`);
      await uploadRawText(page, titleB, `The monthly amount is Rs. 15,000. (ref: ${nonce})`);
      await registerScript({
        id: nonce,
        match: nonce,
        chunks: [JSON.stringify({ changes: [{ id: "c1", explanation: "The monthly amount changed.", quoteA: "Rs. 10,000", quoteB: "Rs. 15,000" }] })],
      });
      await page.goto("/compare");
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: titleA, exact: true }).click();
      await page.getByRole("button", { name: titleB, exact: true }).click();
      await page.getByRole("button", { name: "Compare", exact: true }).click();
      await expect(page).toHaveURL(/\/compare\/[0-9a-f-]+$/, { timeout: 20_000 });
      await page.waitForLoadState("networkidle");
      if (isPhoneProject(testInfo)) {
        await page.getByRole("tab", { name: "Changes" }).click();
      } else {
        await page.getByRole("button", { name: /^Summary of changes/ }).click();
      }
    },
  },
  {
    name: "prepare",
    setup: async (page) => {
      // Byte-identical to 05-prepare.spec.ts's own registered body: this match is the fixed
      // per-lens-stage system-prompt sentence, shared by every Prepare call regardless of which
      // spec fired it — the fake provider's first-match-wins lookup means a concurrently-running
      // screen test's own script could answer this call, or vice versa, so both bodies must agree
      // exactly rather than merely coexist.
      await registerScript({
        id: `sweep-prepare-${randomUUID()}`,
        match: ABOUT_TO_SIGN_MATCH,
        chunks: [
          JSON.stringify({
            lawyerQuestions: [{ question: "What is the notice period before signing?", whyItMatters: "It affects how quickly you can leave.", findingIds: ["F1"] }],
            checklist: [{ item: "Confirm the notice period with the landlord before signing.", findingIds: ["F1"] }],
          }),
        ],
      });
      const documentId = await openLeaseSample(page);
      await page.goto(`/documents/${documentId}/prepare`);
      await expect(page.getByRole("heading", { level: 1, name: /^Prepared for:/ })).toBeVisible({ timeout: 20_000 });
    },
  },
  {
    name: "draft new",
    setup: async (page) => {
      await page.goto("/drafts/new");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "draft view",
    setup: async (page) => {
      const nonce = `e2e-sweep-draft-${randomUUID()}`;
      await registerScript({
        id: nonce,
        match: nonce,
        chunks: [
          JSON.stringify({
            sections: {
              parties_and_premises: "The Licensor and Licensee agree to the premises.",
              term_rent_and_deposit: "The term is eleven months at Rs. 20,000 with a Rs. 60,000 deposit.",
              termination_and_notice: "Either party may terminate on 30 days' written notice.",
              maintenance_and_restrictions: "The Licensee maintains the premises for residential use only.",
              governing_law_and_disputes: "This agreement is governed by Indian law.",
            },
          }),
        ],
      });
      const response = await page.request.post("/api/drafts", {
        data: {
          mode: "from_scratch",
          documentType: "leave_and_license",
          userInstructions: `Draft a lease for a 1BHK, rent 20000, deposit 60000. (ref: ${nonce})`,
          jurisdiction: "IN",
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const { id } = (await response.json()) as { id: string };
      await page.goto(`/drafts/${id}`);
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "library",
    setup: async (page) => {
      await page.goto("/library");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "projects",
    setup: async (page) => {
      await page.goto("/projects");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "project detail",
    setup: async (page) => {
      await page.request.post("/api/auth/dev-sign-in", { data: { displayName: `E2E Sweep ${randomUUID().slice(0, 8)}` } });
      const created = await page.request.post("/api/projects", { data: { name: `Sweep project ${randomUUID().slice(0, 8)}` } });
      const { id } = (await created.json()) as { id: string };
      await page.goto(`/projects/${id}`);
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "settings",
    setup: async (page) => {
      await page.goto("/settings");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "sign-in",
    setup: async (page) => {
      await page.goto("/sign-in");
      await page.waitForLoadState("networkidle");
    },
  },
  {
    name: "404",
    setup: async (page) => {
      await page.goto("/this-route-does-not-exist-at-all");
      await page.waitForLoadState("networkidle");
    },
  },
];

for (const state of STATES) {
  test(`a11y sweep: ${state.name} — zero serious/critical, one h1, one main, a working skip link @a11y`, async ({ page, theme }, testInfo) => {
    test.skip(testInfo.project.name === "phone-dark", "the ticket's own matrix: desktop-light, desktop-dark, phone-light only");
    test.skip(Boolean(state.phoneOnly) && !isPhoneProject(testInfo), `${state.name} only exists on the phone layout`);
    test.setTimeout(90_000);

    await state.setup(page, testInfo);
    await assertThemeApplied(page, theme);

    if (!state.overlay) await assertSingleMainAndSkipLink(page);

    const results = await new AxeBuilder({ page }).exclude(AXE_EXCLUDE).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
}
