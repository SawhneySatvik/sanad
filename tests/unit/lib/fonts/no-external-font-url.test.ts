/**
 * Every face is self-hosted via next/font/google — the loader downloads once at build time and
 * serves every font file from /_next/static/media/, never a live
 * fonts.googleapis.com/fonts.gstatic.com request from the browser. Two halves:
 *
 * 1. A static source scan (this file's main describe block): no literal reference to either host
 *    anywhere in src/, and every face is applied once, on <html>, so content portalled into <body>
 *    (dialogs, sheets, menus, toasts) inherits the same faces as the page. This runs on every `npm test`, with no build required,
 *    and is red-proven below.
 * 2. A `.next` build-output scan, run only when a production build's CSS is present. The
 *    red-proof below rests on the source scan, not on this half. Scans
 *    the whole of .next/static, not a fixed css/ subfolder — Turbopack places generated CSS under
 *    static/chunks/ alongside JS, confirmed by inspecting a real build's own output tree rather
 *    than assumed from convention.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_HOST = /fonts\.(googleapis|gstatic)\.com/;
const SOURCE_FILE = /\.(ts|tsx|css)$/;

interface SourceFile {
  file: string;
  source: string;
}

function scanForExternalFontUrls(files: SourceFile[]): string[] {
  return files.filter((f) => FORBIDDEN_HOST.test(f.source)).map((f) => f.file);
}

function srcFiles(): SourceFile[] {
  const root = process.cwd();
  return readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
}

describe("no external font URL anywhere in src/", () => {
  it("scans the whole of src/ (positive control)", () => {
    const files = srcFiles().map((f) => f.file);
    expect(files).toEqual(expect.arrayContaining(["src/app/globals.css", "src/app/fonts.ts"]));
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no fonts.googleapis.com or fonts.gstatic.com reference anywhere in src/", () => {
    expect(scanForExternalFontUrls(srcFiles())).toEqual([]);
  });

  it("the root layout applies every face's variable on <html>, so portalled content inherits them", () => {
    const layout = readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/from "\.\/fonts"/);
    const html = layout.slice(layout.indexOf("<html"), layout.indexOf("<body"));
    for (const face of ["sourceSerif", "plexSans", "devanagari", "literata", "plexMono"]) {
      expect(html).toContain(`\${${face}.variable}`);
    }
  });
});

describe("red-proof: scanForExternalFontUrls", () => {
  it("flags a planted external font URL", () => {
    const planted = [{ file: "src/app/fake.ts", source: 'const href = "https://fonts.googleapis.com/css2?family=Foo";' }];
    expect(scanForExternalFontUrls(planted)).toEqual(["src/app/fake.ts"]);
  });

  it("does not flag a clean file", () => {
    expect(scanForExternalFontUrls([{ file: "src/app/fake.ts", source: "export const x = 1;" }])).toEqual([]);
  });
});

describe(".next build-output font-face check (best-effort; runs when a production build exists)", () => {
  it("every @font-face src in any built CSS is same-origin, never another host, when build output exists", () => {
    const staticDir = path.join(process.cwd(), ".next/static");
    if (!existsSync(staticDir)) return; // no production build has run in this session — nothing to check yet

    const cssFiles = readdirSync(staticDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"));

    const externalFontFaceUrls: string[] = [];
    for (const css of cssFiles) {
      for (const block of css.matchAll(/@font-face\s*{[^}]*}/g)) {
        for (const url of block[0].matchAll(/url\(([^)]+)\)/g)) {
          // The build writes these relative to its own chunk ("../media/…") or root-relative; only a
          // scheme or a protocol-relative "//" would reach another origin.
          const src = url[1].replace(/^["']|["']$/g, "");
          if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("data:")) externalFontFaceUrls.push(src);
          else if (src.startsWith("//")) externalFontFaceUrls.push(src);
        }
      }
    }
    expect(externalFontFaceUrls).toEqual([]);
  });
});
