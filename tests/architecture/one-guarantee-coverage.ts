// Channel-coverage checklist: every One Guarantee channel in docs/ARCHITECTURE.md has at least
// one POSITIVE (the legitimate path produces the trusted outcome) and one NEGATIVE (the
// forged/failure path never produces `verified`) test, per ./one-guarantee-channels.json.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const ARCHITECTURE_DOC = "docs/ARCHITECTURE.md";
export const REGISTRY_FILE = "tests/architecture/one-guarantee-channels.json";
// `npm test -- verify` is the One Guarantee release-blocker suite, and vitest's filter matches
// file paths, so each channel needs a positive AND a negative test in a file whose path contains
// this. Entries from other files may be listed as extra context.
export const RELEASE_BLOCKER_FILTER = "verify";

export interface RegistryEntry {
  file: string;
  test: string;
}

export interface ChannelEntry {
  number: number;
  name: string;
  positive: RegistryEntry[];
  negative: RegistryEntry[];
}

export interface Registry {
  channels: ChannelEntry[];
}

export interface DocChannel {
  number: number;
  name: string;
}

// Rows of the "Channels this holds across" table: `| 1 | **Model response payload** | ... |`.
// Parsed from the doc's own table, so a channel added, removed or renamed there fails until the
// registry follows.
export function parseDocChannels(markdown: string): DocChannel[] {
  const start = markdown.indexOf("**Channels this holds across:**");
  if (start === -1) throw new Error(`${ARCHITECTURE_DOC}: the "Channels this holds across" table is gone`);
  const channels: DocChannel[] = [];
  for (const line of markdown.slice(start).split("\n").slice(1)) {
    if (channels.length > 0 && !line.startsWith("|")) break;
    const row = /^\|\s*(\d+)\s*\|\s*\*\*(.+?)\*\*/.exec(line);
    if (row) channels.push({ number: Number(row[1]), name: row[2] });
  }
  return channels;
}

// Modifiers that make a test (or every test under a describe) not run unconditionally, or run
// inverted (`fails`), or focus the run (`only`) — none of them can stand as coverage.
const DISQUALIFYING = new Set(["skip", "todo", "only", "fails", "skipIf", "runIf"]);
const TEST_FNS = new Set(["it", "test"]);
const SUITE_FNS = new Set(["describe", "suite"]);

interface TestApiCall {
  base: string;
  modifiers: string[];
}

// `it(...)`, `it.skip(...)`, `it.each(rows)(...)`, `describe.skipIf(c)(...)` → base + modifiers.
function testApiCall(callee: ts.Expression): TestApiCall | null {
  const modifiers: string[] = [];
  let node: ts.Expression = callee;
  for (;;) {
    if (ts.isIdentifier(node)) {
      return TEST_FNS.has(node.text) || SUITE_FNS.has(node.text) ? { base: node.text, modifiers } : null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      modifiers.push(node.name.text);
      node = node.expression;
    } else if (ts.isCallExpression(node)) {
      node = node.expression;
    } else {
      return null;
    }
  }
}

export interface FoundTest {
  title: string;
  live: boolean;
  line: number;
}

// Every `it`/`test` with a literal title, and whether it runs unconditionally. Found with the
// TypeScript compiler, not a text search: a title that only survives in a comment, belongs to a
// `describe`, or sits on a disqualified test does not count.
export function findTests(fileName: string, source: string): FoundTest[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: FoundTest[] = [];
  const visit = (node: ts.Node, underDeadSuite: boolean): void => {
    let dead = underDeadSuite;
    if (ts.isCallExpression(node)) {
      const api = testApiCall(node.expression);
      const [first] = node.arguments;
      if (api && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        const disqualified = underDeadSuite || api.modifiers.some((m) => DISQUALIFYING.has(m));
        if (TEST_FNS.has(api.base)) {
          found.push({ title: first.text, live: !disqualified, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
        } else {
          dead = disqualified;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, dead));
  };
  visit(sf, false);
  return found;
}

export interface CheckInput {
  docChannels: DocChannel[];
  registry: Registry;
  // Repo-relative path → source, or null when the file does not exist.
  readTestFile: (file: string) => string | null;
}

const VITEST_INCLUDE = /^(src|tests)\/.+\.test\.tsx?$/;

export function checkCoverage({ docChannels, registry, readTestFile }: CheckInput): string[] {
  const errors: string[] = [];

  const numbers = docChannels.map((c) => c.number);
  const expected = Array.from({ length: 10 }, (_, i) => i + 1);
  if (numbers.join() !== expected.join()) {
    errors.push(`${ARCHITECTURE_DOC} lists channels [${numbers.join(", ")}], expected exactly 1..10 in order`);
  }

  const docNames = docChannels.map((c) => `${c.number}. ${c.name}`);
  const registryNames = registry.channels.map((c) => `${c.number}. ${c.name}`);
  if (docNames.join("\n") !== registryNames.join("\n")) {
    errors.push(`registry channels differ from ${ARCHITECTURE_DOC}:\n  doc:      ${docNames.join(" | ")}\n  registry: ${registryNames.join(" | ")}`);
  }

  const testsByFile = new Map<string, FoundTest[] | null>();
  const testsIn = (file: string) => {
    if (!testsByFile.has(file)) {
      const source = readTestFile(file);
      testsByFile.set(file, source === null ? null : findTests(file, source));
    }
    return testsByFile.get(file)!;
  };

  for (const channel of registry.channels) {
    const label = `channel ${channel.number} (${channel.name})`;
    for (const polarity of ["positive", "negative"] as const) {
      const entries = channel[polarity] ?? [];
      let inReleaseBlocker = 0;
      for (const entry of entries) {
        const where = `${label} ${polarity}: ${entry.file} › "${entry.test}"`;
        if (!VITEST_INCLUDE.test(entry.file)) {
          errors.push(`${where} — not a file vitest collects (src/** or tests/** *.test.ts)`);
          continue;
        }
        const tests = testsIn(entry.file);
        if (tests === null) {
          errors.push(`${where} — file does not exist`);
          continue;
        }
        const matches = tests.filter((t) => t.title === entry.test);
        const live = matches.filter((t) => t.live);
        if (matches.length === 0) {
          errors.push(`${where} — no it/test with exactly this title`);
        } else if (live.length === 0) {
          errors.push(`${where} — only a skipped/todo/only/fails/conditional test has this title (line ${matches[0].line})`);
        } else if (matches.length > 1) {
          errors.push(`${where} — ${matches.length} tests share this title (lines ${matches.map((t) => t.line).join(", ")}); the entry is ambiguous`);
        } else if (entry.file.includes(RELEASE_BLOCKER_FILTER)) {
          inReleaseBlocker++;
        }
      }
      if (inReleaseBlocker === 0) {
        errors.push(
          `${label} has NO ${polarity.toUpperCase()} test in the release-blocker suite (\`npm test -- ${RELEASE_BLOCKER_FILTER}\`)` +
            (entries.length > 0 ? ` — ${entries.length} listed, none valid in a "${RELEASE_BLOCKER_FILTER}" file` : ""),
        );
      }
    }
  }
  return errors;
}

export function loadRealTree(root: string, registryFile = REGISTRY_FILE): CheckInput {
  return {
    docChannels: parseDocChannels(readFileSync(path.join(root, ARCHITECTURE_DOC), "utf8")),
    registry: JSON.parse(readFileSync(path.resolve(root, registryFile), "utf8")) as Registry,
    readTestFile: (file) => {
      const full = path.join(root, file);
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    },
  };
}
