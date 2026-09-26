// F6's own three honest-state gates: a 429 (the caller's own limit) and a 503 (provider exhaustion)
// are never conflated in copy, and going offline mid-session disables the composer without ever
// auto-retrying on reconnect. Every other sub-flow this doc's fourteen sub-flows describe (the
// upload reason matrix, native-document capping, expired items, error boundaries) already has its
// own gate under tests/e2e/screens/**; this spec covers only the three the ticket names by name.

import { test, expect } from "../support/fixtures";

test.describe("F6 failure journeys", () => {
  test("F6 failure journeys: 429 and 503 never share copy on the same surface @flow", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    await page.route("**/api/samples/lease/open", (route) =>
      route.fulfill({ status: 429, json: { error: { code: "RATE_LIMITED", message: "You've reached your limit for now. Try again in a little while.", retryAfterSeconds: 45 } } }),
    );
    // Scoped to the main landmark: the same text is also copied into the sr-only assertive
    // LiveRegion node (a real, second element by design, never the same node twice).
    const main = page.getByRole("main");
    await page.getByRole("button", { name: /leave-and-license/ }).click();
    await expect(main.getByText("You've reached your limit for now. Try again in 45 seconds.")).toBeVisible();
    await expect(main.getByText(/providers are busy/)).toHaveCount(0);

    await page.route("**/api/samples/lease/open", (route) =>
      route.fulfill({ status: 503, json: { error: { code: "UPSTREAM_UNAVAILABLE", message: "The AI providers are busy right now.", retryAfterSeconds: 90 } } }),
    );
    await page.getByRole("button", { name: /leave-and-license/ }).click();
    await expect(main.getByText("The AI providers are busy right now. Try again in 2 minutes.")).toBeVisible();
    await expect(main.getByText(/reached your limit/)).toHaveCount(0);
  });

  test("F6 failure journeys: offline disables the composer honestly, and reconnecting fires nothing on its own @flow", async ({
    page,
    context,
  }) => {
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    let askCalls = 0;
    await page.route("**/api/ask", (route) => {
      askCalls += 1;
      return route.continue();
    });

    await context.setOffline(true);
    await expect(page.getByRole("note").filter({ hasText: "You're offline. Saboot needs a connection to read and answer." })).toBeVisible();
    await expect(page.getByLabel("Ask Saboot")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Attach a document" })).toBeDisabled();

    await context.setOffline(false);
    // Nothing queued while offline auto-fires the moment connectivity returns — the user re-sends
    // manually, exactly like a discarded stream's own manual-only retry.
    await page.waitForTimeout(500);
    expect(askCalls).toBe(0);
    await expect(page.getByLabel("Ask Saboot")).toBeEnabled();
  });
});
