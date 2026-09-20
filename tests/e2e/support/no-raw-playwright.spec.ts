// Static guard: every e2e spec must go through tests/e2e/support/fixtures.ts, never straight to the
// framework's own test package — that's the only file whose context/page fixtures carry the
// non-loopback abort and the per-context IP. A raw call opening a second, unguarded context escapes
// both the same way.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";

const E2E_ROOT = path.join(process.cwd(), "tests", "e2e");
export const FIXTURES_RELATIVE_PATH = "tests/e2e/support/fixtures.ts";
const RAW_CONTEXT_RE = /\bbrowser\.newContext\s*\(/;
const RAW_IMPORT_RE = /from\s+["']@playwright\/test["']/;
// This guard's own violation messages must name what they're flagging in plain English, so its raw
// source necessarily contains both trigger patterns — excluded from its own real-tree scan below
// for that reason, the same way tests/architecture/*.test.ts's self-referential checks exclude
// themselves rather than never being able to describe what they catch. A literal path, not a
// derived one: Playwright's own TS transform doesn't support import.meta here.
const SELF_RELATIVE_PATH = "tests/e2e/support/no-raw-playwright.spec.ts";

interface SourceFile {
  relativePath: string;
  source: string;
}

function findSpecFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return findSpecFiles(full);
    return entry.isFile() && entry.name.endsWith(".spec.ts") ? [full] : [];
  });
}

function realTree(): SourceFile[] {
  return findSpecFiles(E2E_ROOT)
    .map((file) => ({
      relativePath: path.relative(process.cwd(), file).split(path.sep).join("/"),
      source: readFileSync(file, "utf8"),
    }))
    .filter((f) => f.relativePath !== SELF_RELATIVE_PATH);
}

export function scan(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { relativePath, source } of files) {
    if (RAW_CONTEXT_RE.test(source)) {
      violations.push(`${relativePath}: calls browser.newContext(...) directly — use newIsolatedContext() from ./fixtures instead`);
    }
    if (relativePath !== FIXTURES_RELATIVE_PATH && RAW_IMPORT_RE.test(source)) {
      violations.push(`${relativePath}: imports "@playwright/test" directly — import test/expect from "./fixtures" instead`);
    }
  }
  return violations;
}

test("no spec file bypasses fixtures.ts's context guard", () => {
  const files = realTree();
  expect(files.length, "the scan must actually find spec files").toBeGreaterThan(0);
  expect(scan(files)).toEqual([]);
});

// Both synthetic sources below are spliced together (never written as one contiguous literal) so
// this file's own real-tree scan above never flags itself as the violation it's only pretending to
// contain — the same reasoning tests/architecture/network-guard-scope.test.ts's header comment
// gives for splicing its own trigger name.
const ROGUE_CONTEXT_CALL = ["browser", ".newContext("].join("");
const ROGUE_IMPORT_LINE = ["import { test } from ", '"', "@playwright/test", '"', ";"].join("");

test("the scan catches a raw browser.newContext() (red-proven)", () => {
  const rogue = { relativePath: "tests/e2e/support/example.spec.ts", source: `test("x", async ({ browser }) => { await ${ROGUE_CONTEXT_CALL}); });` };
  expect(scan([rogue])).toEqual([
    "tests/e2e/support/example.spec.ts: calls browser.newContext(...) directly — use newIsolatedContext() from ./fixtures instead",
  ]);
});

test("the scan catches a direct @playwright/test import (red-proven), but exempts fixtures.ts itself", () => {
  const rogue = { relativePath: "tests/e2e/screens/example.spec.ts", source: ROGUE_IMPORT_LINE };
  const fixturesFile = { relativePath: FIXTURES_RELATIVE_PATH, source: ROGUE_IMPORT_LINE };
  expect(scan([rogue])).toEqual([`tests/e2e/screens/example.spec.ts: imports "@playwright/test" directly — import test/expect from "./fixtures" instead`]);
  expect(scan([fixturesFile])).toEqual([]);
});
