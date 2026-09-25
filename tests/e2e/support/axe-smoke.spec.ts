// A minimal proof that npm run test:a11y's axe wiring (@axe-core/playwright) actually runs, on its
// own and fast — separately from the real per-screen axe checks, which already run inline inside
// each spec under tests/e2e/screens/**. Tagged @a11y so `playwright test --grep @a11y` picks it up
// on its own.

import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

const ACCESSIBLE_HTML = `<!doctype html><html lang="en"><head><title>axe smoke</title></head>
<body><main><h1>axe smoke</h1><p>A trivially accessible page, to prove the axe wiring runs.</p></main></body></html>`;

test("axe reports zero violations on a trivially accessible page @a11y", async ({ page }) => {
  await page.setContent(ACCESSIBLE_HTML);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
