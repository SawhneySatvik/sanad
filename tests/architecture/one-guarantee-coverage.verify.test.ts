// Each of the 10 One Guarantee channels has >= 1 positive and >= 1 negative test in the
// release-blocker suite, per the registry in ./one-guarantee-channels.json (see
// ./one-guarantee-coverage.ts for the rules). Named *.verify.test.ts so `npm test -- verify` runs it too.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_DOC,
  checkCoverage,
  findTests,
  loadRealTree,
  parseDocChannels,
  REGISTRY_FILE,
  type CheckInput,
  type Registry,
} from "./one-guarantee-coverage";

const ROOT = process.cwd();

// Modifier names are spliced in so a repo-wide grep for focused/skipped tests finds real ones only.
const m = (name: "skip" | "todo" | "only" | "fails") => name;

const DOC_NAMES = [
  "Model response payload",
  "Streaming (chat)",
  "Orchestrator",
  "Model fallback (Gemini → Gemma)",
  "Errors / timeouts / rate limits",
  "Cache",
  "General-mode chat and Drafts",
  "Span / display binding",
  "Persistence / guest-import",
  "Native-document mode",
];

describe("the real tree", () => {
  it(`${ARCHITECTURE_DOC} names exactly the 10 channels, in order`, () => {
    const channels = parseDocChannels(readFileSync(path.join(ROOT, ARCHITECTURE_DOC), "utf8"));
    expect(channels).toEqual(DOC_NAMES.map((name, i) => ({ number: i + 1, name })));
  });

  it(`every channel has a live positive and negative test in the release-blocker suite, per ${REGISTRY_FILE}`, () => {
    expect(checkCoverage(loadRealTree(ROOT))).toEqual([]);
  });

  it("every registry entry resolves to a live test (positive control for the matcher: all of them are found)", () => {
    const { registry, readTestFile } = loadRealTree(ROOT);
    const entries = registry.channels.flatMap((c) => [...c.positive, ...c.negative]);
    expect(entries.length).toBeGreaterThanOrEqual(20);
    for (const entry of entries) {
      const tests = findTests(entry.file, readTestFile(entry.file) ?? "");
      expect(tests.filter((t) => t.title === entry.test && t.live), `${entry.file} › ${entry.test}`).toHaveLength(1);
    }
  });
});

// A tiny self-contained world: one doc channel, one registry, a couple of in-memory test files.
function world(overrides: { files?: Record<string, string>; registry?: Registry; doc?: string } = {}): CheckInput {
  const doc =
    overrides.doc ??
    ["**Channels this holds across:**", "", "| # | Channel | Requires |", "|---|---|---|", ...DOC_NAMES.map((n, i) => `| ${i + 1} | **${n}** | x |`), ""].join(
      "\n",
    );
  const files = overrides.files ?? {
    "src/a.verify.test.ts": `describe("d", () => { it("pos", () => {}); it("neg", () => {}); });`,
  };
  const registry = overrides.registry ?? {
    channels: DOC_NAMES.map((name, i) => ({
      number: i + 1,
      name,
      positive: [{ file: "src/a.verify.test.ts", test: "pos" }],
      negative: [{ file: "src/a.verify.test.ts", test: "neg" }],
    })),
  };
  return { docChannels: parseDocChannels(doc), registry, readTestFile: (file) => files[file] ?? null };
}

function withChannel1(file: string, source: string, test = "neg"): CheckInput {
  const base = world();
  base.registry.channels[0].negative = [{ file, test }];
  const files: Record<string, string> = { "src/a.verify.test.ts": `it("pos", () => {}); it("neg", () => {});`, [file]: source };
  return { ...base, readTestFile: (f) => files[f] ?? null };
}

describe("checkCoverage flags every kind of registry drift", () => {
  it("the synthetic world itself passes (so every failure below is the mutation's doing)", () => {
    expect(checkCoverage(world())).toEqual([]);
  });

  it("a registry entry whose title no test carries", () => {
    expect(checkCoverage(withChannel1("src/b.verify.test.ts", `it("something else", () => {});`))).toEqual([
      'channel 1 (Model response payload) negative: src/b.verify.test.ts › "neg" — no it/test with exactly this title',
      "channel 1 (Model response payload) has NO NEGATIVE test in the release-blocker suite (`npm test -- verify`) — 1 listed, none valid in a \"verify\" file",
    ]);
  });

  it("a registry entry pointing at a file that does not exist", () => {
    const input = world();
    input.registry.channels[5].positive = [{ file: "src/gone.verify.test.ts", test: "pos" }];
    expect(checkCoverage(input)).toEqual([
      'channel 6 (Cache) positive: src/gone.verify.test.ts › "pos" — file does not exist',
      'channel 6 (Cache) has NO POSITIVE test in the release-blocker suite (`npm test -- verify`) — 1 listed, none valid in a "verify" file',
    ]);
  });

  it.each([
    ["a skipped test", `it.${m("skip")}("neg", () => {});`],
    ["a todo test", `it.${m("todo")}("neg");`],
    ["a focused test", `it.${m("only")}("neg", () => {});`],
    ["an inverted (fails) test", `it.${m("fails")}("neg", () => {});`],
    ["a conditional test", `it.skipIf(process.env.CI)("neg", () => {});`],
    ["a test under a skipped describe", `describe.${m("skip")}("d", () => { it("neg", () => {}); });`],
    ["a test under a skipped describe.each", `describe.${m("skip")}.each([1])("d %s", () => { it("neg", () => {}); });`],
  ])("the title on %s does not count", (_name, source) => {
    const errors = checkCoverage(withChannel1("src/b.verify.test.ts", source));
    expect(errors[0]).toMatch(/only a skipped\/todo\/only\/fails\/conditional test has this title/);
    expect(errors[1]).toMatch(/channel 1 .* has NO NEGATIVE test/);
  });

  it("a title that survives only in a comment, a string, or on a describe does not count", () => {
    const source = `// it("neg", () => {})\nconst s = 'it("neg")';\ndescribe("neg", () => { it("other", () => {}); });`;
    expect(checkCoverage(withChannel1("src/b.verify.test.ts", source))[0]).toMatch(/no it\/test with exactly this title/);
  });

  it("two tests sharing the listed title make the entry ambiguous", () => {
    const errors = checkCoverage(withChannel1("src/b.verify.test.ts", `it("neg", () => {});\nit("neg", () => {});`));
    expect(errors[0]).toMatch(/2 tests share this title \(lines 1, 2\)/);
  });

  it("a live test outside the release-blocker filter is not enough on its own", () => {
    expect(checkCoverage(withChannel1("src/b.test.ts", `it("neg", () => {});`))).toEqual([
      "channel 1 (Model response payload) has NO NEGATIVE test in the release-blocker suite (`npm test -- verify`) — 1 listed, none valid in a \"verify\" file",
    ]);
  });

  it("a file vitest would not collect does not count", () => {
    expect(checkCoverage(withChannel1("src/b.verify.ts", `it("neg", () => {});`))[0]).toMatch(/not a file vitest collects/);
  });

  it("a channel with no entries at all", () => {
    const input = world();
    input.registry.channels[9].negative = [];
    expect(checkCoverage(input)).toEqual(["channel 10 (Native-document mode) has NO NEGATIVE test in the release-blocker suite (`npm test -- verify`)"]);
  });

  it("a channel added to, dropped from, or renamed in the doc", () => {
    const rows = DOC_NAMES.map((n, i) => `| ${i + 1} | **${n}** | x |`);
    const doc = (table: string[]) => ["**Channels this holds across:**", "", "| # | Channel | x |", "|---|---|---|", ...table, ""].join("\n");

    expect(checkCoverage(world({ doc: doc([...rows, "| 11 | **Telemetry** | x |"]) }))[0]).toMatch(/lists channels \[1, .*, 11\], expected exactly 1\.\.10/);
    expect(checkCoverage(world({ doc: doc(rows.slice(0, 9)) }))[0]).toMatch(/expected exactly 1\.\.10/);
    expect(checkCoverage(world({ doc: doc(rows.map((r) => r.replace("**Cache**", "**Result cache**"))) }))[0]).toMatch(
      new RegExp(`registry channels differ from ${ARCHITECTURE_DOC.replace(/[.]/g, "\\.")}`),
    );
  });

  it("the REAL registry against a copy of a real test file with one listed title removed", () => {
    const real = loadRealTree(ROOT);
    const file = "tests/unit/server/services/understand.verify.test.ts";
    const title = "negative: a cached fabricated quote — even one carrying status 'verified' — returns not_found, with no LLM call";
    const source = real.readTestFile(file)!;
    expect(source).toContain(title);
    const tampered: CheckInput = { ...real, readTestFile: (f) => (f === file ? source.replace(title, "renamed") : real.readTestFile(f)) };
    expect(checkCoverage(tampered)).toEqual([
      `channel 6 (Cache) negative: ${file} › "${title}" — no it/test with exactly this title`,
      'channel 6 (Cache) has NO NEGATIVE test in the release-blocker suite (`npm test -- verify`) — 1 listed, none valid in a "verify" file',
    ]);
  });

  it("the REAL tree with the same test skipped", () => {
    const real = loadRealTree(ROOT);
    const file = "tests/unit/server/services/understand.verify.test.ts";
    const title = "positive: a cached real quote is verified against the new document's own text";
    const source = real.readTestFile(file)!;
    const skipped = source.replace(`it("${title}"`, `it.${m("skip")}("${title}"`);
    expect(skipped).not.toBe(source);
    const tampered: CheckInput = { ...real, readTestFile: (f) => (f === file ? skipped : real.readTestFile(f)) };
    expect(checkCoverage(tampered)[0]).toMatch(/^channel 6 \(Cache\) positive: .* only a skipped/);
  });
});
