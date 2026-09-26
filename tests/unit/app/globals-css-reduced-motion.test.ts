/**
 * WCAG 2.3.3 Animation from Interactions: globals.css's own `@media (prefers-reduced-motion:
 * reduce)` block is the app-wide fallback — every element gets a near-instant duration unless a
 * more specific rule (the sheet, highlight-mark, streaming-preview, upload-progress) already
 * handles reduced motion its own way. `motion` (the npm package) has no import anywhere under
 * src/, so there is no MotionConfig provider tree to assert on instead — see providers.test.tsx,
 * unchanged by this file, for what Providers actually renders.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Balanced-brace extraction, not a regex .* across newlines: the block itself contains a nested
// `{ ... }` (the `*, ::before, ::after` rule), so a naive "up to the next }" match would return
// only that inner rule and miss the outer @media wrapper closing it.
function extractBlock(css: string, marker: string): string {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const openBrace = css.indexOf("{", start);
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after: ${marker}`);
}

const REQUIRED_DECLARATIONS = [
  "animation-duration: 0.01ms !important",
  "animation-iteration-count: 1 !important",
  "transition-duration: 0.01ms !important",
  "scroll-behavior: auto !important",
];

// The check the two "real file" tests below both run — factored out so the red-proof case exercises
// the exact same logic against a fixture, not a separately-hand-rolled assertion.
function missingFromReducedMotionBlock(css: string): string[] {
  const block = extractBlock(css, "@media (prefers-reduced-motion: reduce)");
  const missing: string[] = [];
  if (!/\*\s*,\s*::before\s*,\s*::after/.test(block)) missing.push("selector *, ::before, ::after");
  for (const declaration of REQUIRED_DECLARATIONS) {
    if (!block.includes(declaration)) missing.push(declaration);
  }
  return missing;
}

describe("globals.css's reduced-motion block", () => {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

  it("declares the media query once", () => {
    expect(css.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
  });

  it("sets *, ::before, ::after and all four declarations, keeping transitions instant rather than removed", () => {
    expect(missingFromReducedMotionBlock(css)).toEqual([]);
  });

  it("cites the WCAG criterion it implements", () => {
    const block = extractBlock(css, "@media (prefers-reduced-motion: reduce)");
    const before = css.slice(Math.max(0, css.indexOf(block) - 1200), css.indexOf(block));
    expect(before).toContain("2.3.3");
  });
});

describe("red-proof: missingFromReducedMotionBlock", () => {
  it("flags a declaration removed from an otherwise-complete block", () => {
    const brokenCss = `
      @media (prefers-reduced-motion: reduce) {
        *, ::before, ::after {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
          scroll-behavior: auto !important;
        }
      }
    `;
    expect(missingFromReducedMotionBlock(brokenCss)).toEqual(["animation-iteration-count: 1 !important"]);
  });

  it("passes when every declaration is present", () => {
    const completeCss = `
      @media (prefers-reduced-motion: reduce) {
        *, ::before, ::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          scroll-behavior: auto !important;
        }
      }
    `;
    expect(missingFromReducedMotionBlock(completeCss)).toEqual([]);
  });
});
