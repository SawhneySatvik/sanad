/**
 * Every one of the five font-stack custom properties references a name (--font-source-serif,
 * --font-devanagari, --font-plex-sans, --font-literata, --font-plex-mono) that only exists once a
 * route's own font loader applies that face's `variable` class — until then, the name is undefined
 * anywhere in the cascade. A var() to an undefined custom property with no fallback makes the
 * *whole* font-family declaration invalid at computed-value time (confirmed against a real
 * production build's own CSS output, not assumed) — every --font-* reference inside these five
 * declarations needs its own generic fallback, or the app silently renders in the browser's
 * default serif the moment the utility is used before its loader is wired in.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FONT_STACK_PROPERTIES = ["--font-display", "--font-sans", "--font-reading", "--font-mono", "--font-heading"];

// Which of FONT_STACK_PROPERTIES the CSS actually declares — a rename or reformat that stops the
// declaration regex matching would otherwise leave fontVarsWithoutFallback silently checking
// nothing for that property, and the "none missing" test below would pass without having
// inspected it. Call sites assert this list separately from the missing-fallback list itself.
function declaredFontStackProperties(css: string): string[] {
  return FONT_STACK_PROPERTIES.filter((property) => new RegExp(`${property}:\\s*[^;]+;`).test(css));
}

function fontVarsWithoutFallback(css: string): string[] {
  const missing: string[] = [];
  for (const property of declaredFontStackProperties(css)) {
    const declared = css.match(new RegExp(`${property}:\\s*([^;]+);`))!;
    for (const [, referenced, fallback] of declared[1].matchAll(/var\(([^),]+)(,[^)]*)?\)/g)) {
      if (referenced.trim().startsWith("--font-") && !fallback) {
        missing.push(`${property} references ${referenced.trim()} with no fallback`);
      }
    }
  }
  return missing;
}

describe("globals.css's font stacks always carry a fallback on every var(--font-*)", () => {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

  it("actually found and checked all five font-stack properties (positive control)", () => {
    expect(declaredFontStackProperties(css)).toEqual(FONT_STACK_PROPERTIES);
  });

  it("the real file has none missing", () => {
    expect(fontVarsWithoutFallback(css)).toEqual([]);
  });
});

describe("red-proof: fontVarsWithoutFallback", () => {
  it("flags a var() with no fallback", () => {
    const css = "--font-display: var(--font-source-serif), var(--font-devanagari, sans-serif), serif;";
    expect(fontVarsWithoutFallback(css)).toEqual(["--font-display references --font-source-serif with no fallback"]);
  });

  it("passes when every var() carries a fallback", () => {
    const css = "--font-display: var(--font-source-serif, serif), var(--font-devanagari, sans-serif), serif;";
    expect(fontVarsWithoutFallback(css)).toEqual([]);
  });
});

describe("red-proof: declaredFontStackProperties itself catches a missed declaration", () => {
  it("a CSS missing one of the five properties is not reported as fully checked", () => {
    const css = "--font-display: var(--font-source-serif, serif);"; // --font-sans and the rest absent
    expect(declaredFontStackProperties(css)).toEqual(["--font-display"]);
    expect(declaredFontStackProperties(css)).not.toEqual(FONT_STACK_PROPERTIES);
  });
});
