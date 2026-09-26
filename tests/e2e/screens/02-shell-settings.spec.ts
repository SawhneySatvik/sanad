// Settings' own done-when gates.

import { randomInt } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, newIsolatedContext } from "../support/fixtures";

/** A fresh per-IP rate-limit budget mid-test, the same mechanism fixtures.ts's own `ip` fixture uses. */
async function refreshIp(page: import("@playwright/test").Page): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}` });
}

/**
 * `page.request` is `context.request` (Playwright's own doc for the getter) — fixed to whatever IP
 * the context was created with, for the test's entire lifetime; `page.setExtraHTTPHeaders()`
 * (what `refreshIp` above calls) only ever changes headers on requests the *page* itself issues.
 * A same-cookie check that needs a budget `refreshIp` actually affects has to run as an in-page
 * fetch, not a `page.request` call — this is that fetch.
 */
async function pageFetch(
  page: import("@playwright/test").Page,
  path: string,
  init?: { method?: string },
): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
  const result = await page.evaluate(
    async ({ path, method }) => {
      const res = await fetch(path, { method });
      return { ok: res.ok, status: res.status, body: await res.text() };
    },
    { path, method: init?.method ?? "GET" },
  );
  return { ok: result.ok, status: result.status, json: async () => JSON.parse(result.body || "null"), text: async () => result.body };
}

// No standalone Page-typed helper: the framework's own test package is only ever imported through
// fixtures.ts in this tree (a static guard enforces it) — every axe call below is inlined instead
// so each page argument stays inferred straight from its own test callback.

test.describe("Settings", () => {
  test("f8.delete-all-clears-guest-session: a guest's list calls return empty afterward under the same cookie, a fresh guest is unaffected", async ({
    page,
    browser,
  }) => {
    // /chat has no page of its own yet — every hit renders the root not-found boundary, and the
    // dev server's on-demand compilation makes a route's *first* request take several seconds on
    // its own; the room this leaves the toHaveURL wait below is for that, not this test's own logic.
    test.setTimeout(45_000);
    await page.request.get("/chat").catch(() => undefined);

    // A single deterministic mint, before /settings' own mount fires several concurrent list/session
    // reads: /chat and /settings are plain pages, not API routes, so neither one mints a guest cookie
    // on its own — without this, those concurrent reads could each independently race to mint their
    // own guest session on a still-cookie-less context, and the sample this test opens right below
    // would land on whichever one happened to win, not necessarily the one every later read carries.
    // page.request, not pageFetch: the page is still at about:blank here, with no origin yet for an
    // in-page fetch("/api/session") to resolve a relative URL against.
    await page.request.get("/api/session");

    await page.goto("/settings");
    // A real guest row this session created (the deterministic sample-open path, no LLM call), so
    // "delete" has something to actually remove, not an already-empty list.
    const opened = await pageFetch(page, "/api/samples/lease/open", { method: "POST" });
    expect(opened.ok, await opened.text()).toBe(true);

    // A fresh budget for the poll below: this file, unlike 02-shell.spec.ts, never stubs
    // RecentsList's four list reads, so /settings' own mount plus the warm-up and open calls above
    // already draw down the fixture-assigned IP's budget before any retry room is needed here.
    await refreshIp(page);
    // Polled, not a single read: under heavy concurrent load elsewhere on the shared e2e server, a
    // read against the same cookie immediately after the write above has occasionally observed 0
    // items before catching up to the just-created row on a following read. `?? 0`, not a bare
    // `.items.length`: an occasional 429 from this same budget has no `items` field at all, and a
    // thrown read here must read as "not yet 1" to the poll, not abort it outright.
    await expect
      .poll(
        async () => {
          const body = (await (await pageFetch(page, "/api/documents")).json()) as { items?: unknown[] } | null;
          return body?.items?.length ?? 0;
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    await expect(page.getByText(/Deleting your data/)).toBeVisible();

    // A fresh budget for the delete itself, its own reset-and-refetch (session plus every one of
    // RecentsList's four list queries, unstubbed in this file), and /chat's own not-found boundary
    // mount just after (the same AppShell, so another five requests) — on its own already close to
    // the cap, before the check below ever needs its own room.
    await refreshIp(page);
    await page.getByRole("button", { name: "Delete all my data" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete all my data" }).click();
    await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });

    // Another fresh budget, now that page's own traffic from the mounts above has settled: the check
    // below needs its own room, not whatever the delete-and-remount sequence left of the last one.
    await refreshIp(page);
    const sameCookieDocs = await pageFetch(page, "/api/documents");
    expect(sameCookieDocs.ok, `status ${sameCookieDocs.status} body ${await sameCookieDocs.text()}`).toBe(true);
    const sameCookieBody = (await sameCookieDocs.json()) as { items: unknown[] };
    expect(sameCookieBody.items).toEqual([]);

    // A genuinely separate guest, not just a fresh page in the same context: newIsolatedContext()
    // is this tree's only sanctioned way to open a second browser context — a bare call straight
    // to the browser's own context-creation method gets neither the per-context IP nor the
    // non-loopback abort every other context in this suite carries.
    const isolated = await newIsolatedContext(browser);
    const freshPage = await isolated.context.newPage();
    const freshDocs = await freshPage.request.get(`${new URL(page.url()).origin}/api/documents`);
    expect(freshDocs.ok()).toBe(true);
    await isolated.close();
  });

  test("f8.delete-all-clears-every-saboot-key-and-removes-local-thread-titles-from-the-sidebar-in-both-tabs: next-themes' own key survives with its pre-delete value", async ({
    page,
    context,
  }, testInfo) => {
    // Same reasoning as the test above: /chat's first hit needs room for the dev server's
    // on-demand compile, kept off the timed assertion via a warm-up request.
    test.setTimeout(45_000);
    const isPhone = testInfo.project.name.startsWith("phone");
    await page.request.get("/chat").catch(() => undefined);

    await page.addInitScript(() => {
      window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-a"]));
      window.localStorage.setItem(
        "saboot:threads:v1:local-a",
        JSON.stringify({ id: "local-a", title: "A thread", documentIds: [], messages: [] }),
      );
      window.localStorage.setItem("saboot:situation:v1", "tenant");
      // Not sidebar-collapsed:true here — the icon rail hides RecentsList entirely by design, and
      // this test needs "A thread" actually visible (the saboot:*-key sweep below still proves the
      // key itself gets cleared regardless of which value it started at).
      window.localStorage.setItem("theme", "dark");
    });
    await page.goto("/settings");
    // On phone RecentsList sits inside the sidebar's own Sheet drawer, closed on every fresh load —
    // opened, checked, then closed again so the delete button in the page's own main content
    // (never inside the drawer) is reachable next.
    if (isPhone) await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByText("A thread")).toBeVisible();
    if (isPhone) await page.keyboard.press("Escape");

    // A second tab, same context — real localStorage (shared at the origin level) already carries
    // the thread seeded above, so this tab's own RecentsList shows it too without any init script
    // of its own.
    const secondPage = await context.newPage();
    await refreshIp(secondPage);
    await secondPage.goto("/settings");
    // Opened once and left open: the drawer's own Sheet unmounts its content while closed, and the
    // "never reloaded and never clicked" claim below is about what happens after this point, not
    // before it — reopening later would remount a fresh RecentsList that trivially reads
    // already-cleared storage, proving nothing about the live cross-tab update.
    if (isPhone) await secondPage.getByRole("button", { name: "Open menu" }).click();
    await expect(secondPage.getByText("A thread")).toBeVisible();

    await refreshIp(page);
    await page.getByRole("button", { name: "Delete all my data" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete all my data" }).click();
    await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });

    const keys = await page.evaluate(() => {
      const out: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) out.push(window.localStorage.key(i) as string);
      return out;
    });
    expect(keys.some((k) => k.startsWith("saboot:"))).toBe(false);
    expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe("dark");

    // This tab: the deleted thread's title is gone from the sidebar DOM immediately, not just from
    // storage — /chat's own not-found boundary still mounts the same AppShell/RecentsList.
    if (isPhone) await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByText("A thread")).toHaveCount(0);

    // The second tab never reloaded and was never clicked — only the cross-tab broadcast (and/or
    // the native storage event local-threads.ts's own listener catches) can be what clears its
    // RecentsList too.
    await expect(secondPage.getByText("A thread")).toHaveCount(0, { timeout: 10_000 });

    await secondPage.close();
  });

  test("theme change via Settings' RadioGroup and via the sidebar's ThemeToggle produce the same persisted value", async ({
    page,
  }, testInfo) => {
    const isPhone = testInfo.project.name.startsWith("phone");
    await page.goto("/settings");
    // Dev-only chrome (also excluded from every axe scan in this file) that can otherwise sit over
    // the sidebar footer and intercept the click below — never present in production, so making it
    // non-interactive here changes nothing this test is actually checking.
    await page.addStyleTag({ content: "nextjs-portal { pointer-events: none !important; }" });
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const afterSettings = await page.evaluate(() => window.localStorage.getItem("theme"));
    expect(afterSettings).toBe("dark");

    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    // ThemeToggle lives in the sidebar footer — on phone that's inside the drawer, which starts
    // closed on every fresh page load.
    if (isPhone) await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe("dark");
  });

  test("f5/D2: a failed session fetch shows the session-failure notice in the Data section, disables Delete all, and never states a 0-hour TTL", async ({
    page,
  }) => {
    await page.route("**/api/session", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } } }),
    );
    await page.goto("/settings");

    const dataSection = page.locator("section", { has: page.getByRole("heading", { name: "Data" }) });
    await expect(dataSection.getByText("We couldn't check your session, so some features are hidden.")).toBeVisible();
    await expect(dataSection.getByText("Deleting your data removes every document, comparison and draft you've created.")).toBeVisible();
    await expect(dataSection.getByText(/about 0 hours/)).toHaveCount(0);
    await expect(dataSection.getByText(/hours anyway/)).toHaveCount(0);
    await expect(dataSection.getByRole("button", { name: "Delete all my data" })).toBeDisabled();
  });

  test("axe: Settings at rest (guest) — zero serious/critical", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).exclude("nextjs-portal").analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("axe: the delete-all ConfirmDeleteDialog open — zero serious/critical", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete all my data" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude("nextjs-portal").analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
