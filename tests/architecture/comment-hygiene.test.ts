// Keeps production comments free of build-process residue (ticket/decision IDs, review-cycle
// language, dangling doc-section references) after a one-time cleanup. Scans src/**'s TypeScript
// comment trivia only — ts.forEachLeadingCommentRange/forEachTrailingCommentRange never look inside
// string or template literals, so quoted prompt text and fixture strings are not scanned.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

interface Hit {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

interface NamedPattern {
  name: string;
  regex: RegExp;
}

// Ticket/decision/risk IDs and channel-count tokens: case-sensitive, since a lowercase match
// ("s3", "t-100" in prose) is not the build-process token these flag.
const ID_PATTERNS: NamedPattern[] = [
  { name: "ticket/decision/risk id", regex: /\b(T|D|R)-\d{3}[a-z]?\b/g },
  { name: "severity token", regex: /\bS\d{1,2}\b/g },
];

// Review-cycle and process phrases: case-insensitive, since real residue in this repo is written
// with a capitalized first word ("Fix cycle 1, review finding 4").
const PHRASE_PATTERNS: NamedPattern[] = [
  { name: "fix-cycle reference", regex: /fix[- ]cycle/gi },
  { name: "review finding", regex: /review finding/gi },
  { name: "orchestrator ruling", regex: /orchestrator ruling/gi },
  { name: "this lane/round/cycle", regex: /\bthis (lane|round|cycle)\b/gi },
  { name: "founder", regex: /\bfounder\b/gi },
  { name: "BOARD.md reference", regex: /BOARD\.md/gi },
  { name: "docs/CLAUDE.md reference", regex: /docs\/CLAUDE\.md/gi },
  { name: "test file:line reference", regex: /\.test\.ts:\d+/g },
  { name: "numbered doc reference", regex: /\b(channel|rule|gotcha) \d+\b/gi },
];

const ALL_PATTERNS = [...ID_PATTERNS, ...PHRASE_PATTERNS];

// Every leading and trailing comment range on every token in the file, deduped by start position —
// a comment can be reachable as both the trailing trivia of the token before it and the leading
// trivia of the token after it (ts.forEachChild alone would skip a comment attached only to a
// closing punctuation token, such as one on its own line just above a `}`).
function collectComments(sourceFile: ts.SourceFile): { pos: number; end: number }[] {
  const fullText = sourceFile.getFullText();
  const seen = new Set<number>();
  const ranges: { pos: number; end: number }[] = [];

  function record(pos: number, end: number): void {
    if (seen.has(pos)) return;
    seen.add(pos);
    ranges.push({ pos, end });
  }

  function visit(node: ts.Node): void {
    ts.forEachLeadingCommentRange(fullText, node.getFullStart(), (pos, end) => record(pos, end));
    ts.forEachTrailingCommentRange(fullText, node.getEnd(), (pos, end) => record(pos, end));
    node.getChildren(sourceFile).forEach(visit);
  }

  visit(sourceFile);
  return ranges;
}

function scanSource(relativePath: string, source: string): Hit[] {
  // A .tsx file must parse as TSX: JSX text (e.g. a bare URL) can contain "//", which the TS
  // scanner would otherwise read as a line comment when parsed as plain TS.
  const kind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, false, kind);
  const hits: Hit[] = [];
  for (const { pos, end } of collectComments(sourceFile)) {
    const text = source.slice(pos, end);
    for (const { name, regex } of ALL_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(text)) {
        const line = sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
        hits.push({ file: relativePath, line, pattern: name, text: text.trim() });
      }
    }
  }
  return hits;
}

const SOURCE_FILE = /\.(ts|tsx)$/;

function srcFiles(): { file: string; source: string }[] {
  const root = process.cwd();
  return readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
}

function scanTree(files: { file: string; source: string }[]): Hit[] {
  return files.flatMap(({ file, source }) => scanSource(file, source));
}

function formatHits(hits: Hit[]): string[] {
  return hits.map((h) => `${h.file}:${h.line}  [${h.pattern}]  ${h.text}`);
}

// `--` line comments in applied SQL migrations, scanned with the same phrase/id patterns. Never
// edited even if flagged: src/db/migrate.ts checksums the whole file, so an edited comment breaks
// every database that already applied it.
function sqlMigrationFiles(): { file: string; source: string }[] {
  const root = process.cwd();
  const dir = path.join(root, "src", "db", "migrations");
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
}

function scanSqlComments(files: { file: string; source: string }[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, source } of files) {
    const lines = source.split("\n");
    lines.forEach((lineText, index) => {
      // A "--" inside a single-quoted SQL string literal is not a comment; skip lines with an odd
      // number of quotes before the marker rather than parse full SQL string escaping.
      const markerIndex = lineText.indexOf("--");
      if (markerIndex === -1) return;
      const before = lineText.slice(0, markerIndex);
      if ((before.match(/'/g)?.length ?? 0) % 2 !== 0) return;
      const comment = lineText.slice(markerIndex);
      for (const { name, regex } of ALL_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(comment)) hits.push({ file, line: index + 1, pattern: name, text: comment.trim() });
      }
    });
  }
  return hits;
}

describe("src/ comments carry no build-process residue", () => {
  const files = srcFiles();

  it("scans the whole of src/ (positive control: known production files are read)", () => {
    const names = files.map((f) => f.file);
    expect(names).toEqual(expect.arrayContaining(["src/server/deterministic/verify/verify.ts", "src/app/api/health/route.ts"]));
    expect(names.length).toBeGreaterThan(100);
  });

  it("flags no ticket/decision/risk id, severity token, fix-cycle, review-finding, orchestrator-ruling, lane/round/cycle, founder, BOARD.md, docs/CLAUDE.md, test-line or numbered-doc reference in any comment", () => {
    const hits = scanTree(files);
    expect(formatHits(hits)).toEqual([]);
  });

  it("has clean SQL migration comments too (never edited even if this failed)", () => {
    const hits = scanSqlComments(sqlMigrationFiles());
    expect(formatHits(hits)).toEqual([]);
  });
});

// docs/, tests/ and scripts/ are prose, JSON and fixtures, not TypeScript — there is no "comment" to
// isolate the way scanSource() does for src/, so every line of a tracked file (and the filename
// itself) is checked as-is for the two residue shapes that must never reach a public tree: a
// ticket/decision/risk id, and a path into the gitignored internal-planning directory.
const WIDENED_ROOTS = ["docs", "tests", "scripts"];
const RAW_TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".json", ".txt", ".mjs", ".mts", ".snap"]);
const PLANNING_PATH = "internal planning path";

// Scoped to the exact file and token, not the whole file, so any OTHER id landing in the same file
// still fails this scan. Self-expiring: once a listed token is no longer in its file, the entry
// itself starts failing the scan below, so a stale exemption can't silently linger once someone
// removes the id it names.
const WIDENED_EXEMPTIONS: { file: string; token: string }[] = [];

function listWidenedFiles(): string[] {
  const root = process.cwd();
  const out: string[] = [];
  for (const dir of WIDENED_ROOTS) {
    for (const entry of readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      out.push(path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

/** Every line of a non-TypeScript tracked file, checked as raw text — no comment isolation. */
function scanRawText(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  source.split("\n").forEach((lineText, index) => {
    const line = index + 1;
    const matches = lineText.match(ID_PATTERNS[0].regex) ?? [];
    for (let i = 0; i < matches.length; i++) {
      hits.push({ file, line, pattern: ID_PATTERNS[0].name, text: lineText.trim() });
    }
    if (lineText.includes(".planning/")) {
      hits.push({ file, line, pattern: PLANNING_PATH, text: lineText.trim() });
    }
  });
  return hits;
}

/** A ticket/decision/risk id sitting in the filename itself (e.g. a per-ticket fixture file). */
function scanFilename(file: string): Hit | null {
  const base = path.basename(file);
  if ((base.match(ID_PATTERNS[0].regex) ?? []).length === 0) return null;
  return { file, line: 0, pattern: "ticket/decision/risk id in filename", text: base };
}

describe("docs/, tests/ and scripts/ carry no ticket/decision/risk id or internal-planning path", () => {
  const files = listWidenedFiles();

  it("scans the whole of docs/, tests/ and scripts/ (positive control: known files are read)", () => {
    expect(files).toEqual(
      expect.arrayContaining(["docs/ARCHITECTURE.md", "tests/architecture/comment-hygiene.test.ts", "scripts/capture-screens.ts"]),
    );
    expect(files.length).toBeGreaterThan(50);
  });

  it("flags no id/path in file content, and none in any filename", () => {
    const root = process.cwd();
    const hits: Hit[] = [];
    const unusedExemptions = new Set(WIDENED_EXEMPTIONS.map((e) => `${e.file}\u0000${e.token}`));
    for (const file of files) {
      // This file's own red-proof fixtures below plant the exact strings this scan looks for.
      if (file === "tests/architecture/comment-hygiene.test.ts") continue;
      const filenameHit = scanFilename(file);
      if (filenameHit) hits.push(filenameHit);
      if (!RAW_TEXT_EXTENSIONS.has(path.extname(file))) continue;
      const source = readFileSync(path.join(root, file), "utf8");
      const exemptions = WIDENED_EXEMPTIONS.filter((e) => e.file === file);
      hits.push(
        ...scanRawText(file, source).filter((hit) => {
          const exemption = exemptions.find((e) => hit.text.includes(e.token));
          if (!exemption) return true;
          unusedExemptions.delete(`${exemption.file}\u0000${exemption.token}`);
          return false;
        }),
      );
    }
    // A listed exemption whose token is no longer in its file is stale — remove the entry above.
    for (const stale of unusedExemptions) {
      const [file, token] = stale.split("\u0000");
      hits.push({ file, line: 0, pattern: "stale exemption", text: `"${token}" no longer appears in this file — remove this WIDENED_EXEMPTIONS entry` });
    }
    expect(formatHits(hits)).toEqual([]);
  });
});

describe("red-proof (widened scan)", () => {
  it("flags a ticket id sitting in a markdown/json/txt line, outside any comment", () => {
    expect(formatHits(scanRawText("docs/example.md", "See T-999 for details"))).toEqual([
      "docs/example.md:1  [ticket/decision/risk id]  See T-999 for details",
    ]);
  });

  it("flags an internal-planning path", () => {
    expect(formatHits(scanRawText("scripts/example.ts", "// see .planning/example.md for background"))).toEqual([
      `scripts/example.ts:1  [${PLANNING_PATH}]  // see .planning/example.md for background`,
    ]);
  });

  it("flags a ticket id sitting in a filename", () => {
    expect(scanFilename("tests/e2e/support/capture/states/T-999.ts")).toMatchObject({ pattern: "ticket/decision/risk id in filename" });
  });

  it("does not flag a clean filename", () => {
    expect(scanFilename("tests/e2e/support/capture/states/shell.ts")).toBeNull();
  });
});

describe("red-proof", () => {
  it("flags a synthetic ticket-id comment, and does not flag the same text inside a string literal", () => {
    const flagged = scanSource("src/server/example.ts", "// T-123: temporary workaround\nexport const x = 1;\n");
    expect(formatHits(flagged)).toEqual(["src/server/example.ts:1  [ticket/decision/risk id]  // T-123: temporary workaround"]);

    const clean = scanSource("src/server/example.ts", 'export const label = "T-123";\n');
    expect(formatHits(clean)).toEqual([]);
  });

  it("flags a comment attached only to a closing brace, on its own line", () => {
    const source = ["export function run() {", "  return 1;", "  // fix cycle 1", "}", ""].join("\n");
    const hits = scanSource("src/server/example.ts", source);
    expect(formatHits(hits)).toEqual(["src/server/example.ts:3  [fix-cycle reference]  // fix cycle 1"]);
  });

  it("flags every remaining pattern once, on a planted comment per pattern", () => {
    const cases: [string, string][] = [
      ["severity token", "// S3 must never regress"],
      ["review finding", "// Review finding 2 changed this"],
      ["orchestrator ruling", "// per orchestrator ruling"],
      ["this lane/round/cycle", "// scoped to this round"],
      ["founder", "// pending the founder's call"],
      ["BOARD.md reference", "// see tickets/BOARD.md"],
      ["docs/CLAUDE.md reference", "// see docs/CLAUDE.md"],
      ["test file:line reference", "// breaks handler.claim.test.ts:136"],
      ["numbered doc reference", "// see rule 11"],
    ];
    for (const [pattern, comment] of cases) {
      const hits = scanSource("src/server/example.ts", `${comment}\nexport const x = 1;\n`);
      expect(hits.map((h) => h.pattern), comment).toContain(pattern);
    }
  });
});
