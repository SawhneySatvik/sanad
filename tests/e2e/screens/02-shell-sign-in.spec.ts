// The "Dev sign-in" screen's own done-when gates: the session-failure redirect, the
// disabled-until-non-empty submit, and the phone/desktop gutter.

import { test, expect } from "../support/fixtures";

test.describe("Dev sign-in", () => {
  test("a failed session fetch redirects away from /sign-in without ever rendering the form, via sessionSignInAvailable()", async ({
    page,
  }) => {
    await page.route("**/api/session", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } } }),
    );
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/chat$/, { timeout: 10_000 });
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
  });

  test("submit stays disabled until the field holds a non-empty name", async ({ page }) => {
    await page.goto("/sign-in");
    const submit = page.getByRole("button", { name: "Sign in" });
    await expect(submit).toBeDisabled();

    await page.getByLabel("Name", { exact: true }).fill("Ada");
    await expect(submit).toBeEnabled();

    await page.getByLabel("Name", { exact: true }).fill("   ");
    await expect(submit).toBeDisabled();
  });

  test("the card sits inside a full-width gutter with a 400px inner column", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("heading", { name: "Sign in" }).waitFor();

    const layout = await page.evaluate(() => {
      const heading = document.querySelector("h1");
      const inner = heading?.parentElement?.parentElement ?? null;
      const outer = inner?.parentElement ?? null;
      return {
        outerHasGutter: outer?.className.includes("px-4") ?? false,
        innerHasMaxWidth: inner?.className.includes("max-w-[400px]") ?? false,
      };
    });
    expect(layout.outerHasGutter).toBe(true);
    expect(layout.innerHasMaxWidth).toBe(true);
  });
});
