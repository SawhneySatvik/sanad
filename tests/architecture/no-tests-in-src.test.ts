// src/ holds production code only; every test, snapshot and test helper lives under tests/. A test
// left in src/ is also outside vitest's include, so it would silently never run.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface SourceFile {
  file: string;
  source: string;
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const VITEST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']vitest(?:\/[^"']*)?["']/;
// A test double needs no vitest import, so it is recognised by name: an exported Fake* declaration
// or a Fake* name in an export list.
const TEST_DOUBLE_EXPORT =
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|function\*?|const|let|var|interface|type|enum)\s+(Fake[A-Z_]\w*)|\bexport\s*(?:type\s*)?\{[^}]*?\b(Fake[A-Z_]\w*)/;

function testCodeIn(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { file, source } of files) {
    const name = path.posix.basename(file);
    if (TEST_FILE.test(name)) violations.push(`${file}: a test file`);
    if (name.endsWith(".snap") || file.includes("/__snapshots__/")) violations.push(`${file}: a snapshot`);
    if (name.includes(".test-support.")) violations.push(`${file}: a test-support module`);
    if (SOURCE_FILE.test(name) && VITEST_IMPORT.test(source)) violations.push(`${file}: imports vitest`);
  }
  return violations;
}

function testDoublesIn(files: SourceFile[]): string[] {
  return files.flatMap(({ file, source }) => {
    const match = SOURCE_FILE.test(file) ? TEST_DOUBLE_EXPORT.exec(source) : null;
    return match ? [`${file}: exports a test double (${match[1] ?? match[2]})`] : [];
  });
}

function srcTree(): SourceFile[] {
  const root = process.cwd();
  return readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .map((file) => ({ file, source: SOURCE_FILE.test(file) ? readFileSync(path.join(root, file), "utf8") : "" }));
}

describe("src/ holds no test code", () => {
  const files = srcTree();

  it("has no test file, snapshot, test-support module or vitest import", () => {
    expect(testCodeIn(files)).toEqual([]);
  });

  it("exports no test double (a Fake* class, type or value)", () => {
    expect(testDoublesIn(files)).toEqual([]);
  });

  it("scans the whole of src/ (positive control: known production files are read)", () => {
    const names = files.map((f) => f.file);
    expect(names).toEqual(expect.arrayContaining(["src/server/deterministic/verify/verify.ts", "src/app/api/health/route.ts"]));
    expect(names.length).toBeGreaterThan(100);
    expect(files.find((f) => f.file === "src/server/deterministic/verify/verify.ts")?.source).toContain("export");
  });
});

describe("testCodeIn flags each kind of test code", () => {
  it("flags each kind of test code, and passes a production module", () => {
    const planted: SourceFile[] = [
      { file: "src/server/llm/gemini.test.ts", source: "" },
      { file: "src/server/llm/__snapshots__/provider-schema.test.ts.snap", source: "" },
      { file: "src/server/data/documents.test-support.ts", source: "" },
      { file: "src/server/llm/contract.ts", source: `import { describe, expect, it } from "vitest";\n` },
      { file: "src/server/llm/fake.ts", source: `const { vi } = await import("vitest");\n` },
      { file: "src/server/core/errors.ts", source: `import { z } from "zod";\nexport const note = "vitest";\n` },
    ];

    expect(testCodeIn(planted)).toEqual([
      "src/server/llm/gemini.test.ts: a test file",
      "src/server/llm/__snapshots__/provider-schema.test.ts.snap: a snapshot",
      "src/server/data/documents.test-support.ts: a test-support module",
      "src/server/llm/contract.ts: imports vitest",
      "src/server/llm/fake.ts: imports vitest",
    ]);
  });

  it("flags every exported Fake* form, and passes a module that only mentions one", () => {
    const planted: SourceFile[] = [
      { file: "src/server/llm/fake.ts", source: `import type { LlmClient } from "./types";\nexport class FakeLlmClient implements LlmClient {}\n` },
      { file: "src/server/llm/fake-types.ts", source: `export type FakeLlmScript = string;\n` },
      { file: "src/server/storage/index.ts", source: `export { LocalFsAdapter, FakeStorage as Storage } from "./adapters";\n` },
      {
        file: "src/server/llm/capabilities.ts",
        source: `// FakeLlmClient reports these when configured to.\nconst fakeAnswer = "FakeLlmClient";\nexport const capabilities = { fakeAnswer };\n`,
      },
    ];

    expect(testDoublesIn(planted)).toEqual([
      "src/server/llm/fake.ts: exports a test double (FakeLlmClient)",
      "src/server/llm/fake-types.ts: exports a test double (FakeLlmScript)",
      "src/server/storage/index.ts: exports a test double (FakeStorage)",
    ]);
  });
});
