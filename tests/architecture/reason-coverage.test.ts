// Keeps "every real INVALID_DOCUMENT/EXTRACTION_FAILED throw site names a reason" true as new throw
// sites are added, instead of a mapping table that silently rots. Scans two shapes across all of
// src/server: `new AppError("INVALID_DOCUMENT" | "EXTRACTION_FAILED", …)` with
// no `reason` in its options object, and an `{ type: "error", code: "INVALID_DOCUMENT" |
// "EXTRACTION_FAILED", … }` object literal with no `reason` property (OrchestratorEvent's direct
// yield sites). Only a literal code is seen — a dynamically computed code (sandbox.ts's `parseInWorker`,
// the ExtractionAbortedError `super()` call, handler.ts's `tooLargeError`, sse.ts's `errorOf`) is
// invisible to a static scan and is covered instead by the reason-mapping unit tests.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const DOCUMENT_CODES = new Set(["INVALID_DOCUMENT", "EXTRACTION_FAILED"]);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function parse(relativePath: string, source: string): ts.SourceFile {
  const kind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind);
}

function stringLiteralText(expr: ts.Expression | undefined): string | undefined {
  return expr && ts.isStringLiteralLike(expr) ? expr.text : undefined;
}

function propertyNamed(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(
    (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === name,
  );
}

function hasReasonProperty(optionsArg: ts.Expression | undefined): boolean {
  return optionsArg !== undefined && ts.isObjectLiteralExpression(optionsArg) && propertyNamed(optionsArg, "reason") !== undefined;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Every reason-coverage violation in one source file's text — exported for the red-proof test below. */
export function scanReasonCoverage(relativePath: string, source: string): Violation[] {
  const sourceFile = parse(relativePath, source);
  const violations: Violation[] = [];

  walk(sourceFile, (node) => {
    // new AppError("INVALID_DOCUMENT" | "EXTRACTION_FAILED", message, options?) — options is the
    // third argument; a missing or non-literal `reason` inside it both fail the same way.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "AppError") {
      const args = node.arguments ?? [];
      const code = stringLiteralText(args[0]);
      if (code !== undefined && DOCUMENT_CODES.has(code) && !hasReasonProperty(args[2])) {
        violations.push({ file: relativePath, line: lineOf(sourceFile, node), text: `new AppError(${JSON.stringify(code)}, …) has no reason option` });
      }
    }

    // { type: "error", code: "INVALID_DOCUMENT" | "EXTRACTION_FAILED", … } object literals —
    // run-orchestrator.ts's (and any future module's) direct yield sites.
    if (ts.isObjectLiteralExpression(node)) {
      const typeProp = propertyNamed(node, "type");
      const isErrorEvent =
        typeProp !== undefined &&
        ts.isPropertyAssignment(typeProp) &&
        stringLiteralText(typeProp.initializer) === "error";
      const codeProp = propertyNamed(node, "code");
      const code = codeProp !== undefined && ts.isPropertyAssignment(codeProp) ? stringLiteralText(codeProp.initializer) : undefined;
      const hasReason = propertyNamed(node, "reason") !== undefined;
      if (isErrorEvent && code !== undefined && DOCUMENT_CODES.has(code) && !hasReason) {
        violations.push({ file: relativePath, line: lineOf(sourceFile, node), text: `{ type: "error", code: ${JSON.stringify(code)}, … } has no reason` });
      }
    }
  });

  return violations;
}

const SOURCE_FILE = /\.(ts|tsx|mts)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;

function serverFiles(): { file: string; source: string }[] {
  const root = process.cwd();
  const dir = path.join(root, "src", "server");
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
}

function formatViolations(violations: Violation[]): string[] {
  return violations.map((v) => `${v.file}:${v.line}  ${v.text}`);
}

describe("src/server: every literal INVALID_DOCUMENT/EXTRACTION_FAILED throw or error-event names a reason", () => {
  it("scans the whole of src/server (positive control: known production files are read)", () => {
    const files = serverFiles().map((f) => f.file);
    expect(files).toEqual(
      expect.arrayContaining(["src/server/deterministic/extract/index.ts", "src/server/orchestrator/run-orchestrator.ts"]),
    );
    expect(files.length).toBeGreaterThan(50);
  });

  it("flags no construction or literal with a missing reason", () => {
    const violations = serverFiles().flatMap(({ file, source }) => scanReasonCoverage(file, source));
    expect(formatViolations(violations)).toEqual([]);
  });
});

describe("red-proof", () => {
  it("flags a bare `new AppError(\"INVALID_DOCUMENT\", …)` with no reason option", () => {
    const source = 'import { AppError } from "@/server/core/errors";\nexport function f() { throw new AppError("INVALID_DOCUMENT", "bad"); }\n';
    expect(formatViolations(scanReasonCoverage("src/server/example.ts", source))).toEqual([
      'src/server/example.ts:2  new AppError("INVALID_DOCUMENT", …) has no reason option',
    ]);
  });

  it("flags a bare `{ type: \"error\", code: \"EXTRACTION_FAILED\" }` object literal with no reason", () => {
    const source = "export function* g() { yield { type: \"error\", code: \"EXTRACTION_FAILED\" }; }\n";
    expect(formatViolations(scanReasonCoverage("src/server/example.ts", source))).toEqual([
      'src/server/example.ts:1  { type: "error", code: "EXTRACTION_FAILED", … } has no reason',
    ]);
  });

  it("does not flag a construction/literal that does carry a reason, a different code, or a dynamic code", () => {
    const clean = [
      'import { AppError } from "@/server/core/errors";',
      'export function f() { throw new AppError("INVALID_DOCUMENT", "bad", { reason: "too_large" }); }',
      'export function g() { throw new AppError("VALIDATION_FAILED", "bad"); }',
      'export function h(code: string) { throw new AppError(code, "bad"); }',
      'export function* i() { yield { type: "error", code: "INVALID_DOCUMENT", reason: "empty" }; }',
    ].join("\n");
    expect(scanReasonCoverage("src/server/example.ts", clean)).toEqual([]);
  });
});
