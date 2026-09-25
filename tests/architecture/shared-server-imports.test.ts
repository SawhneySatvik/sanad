import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : /\.[jt]sx?$/.test(file) ? [file] : [];
  });
}

function hasRuntimeServerImport(source: string, file: string): boolean {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let runtimeServerImport = false;
  const serverPath = (node: ts.Node | undefined) => !!node && ts.isStringLiteralLike(node) && node.text.startsWith("@/server/");
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && serverPath(node.moduleSpecifier) && !node.importClause?.isTypeOnly) runtimeServerImport = true;
    if (ts.isExportDeclaration(node) && serverPath(node.moduleSpecifier) && !node.isTypeOnly) runtimeServerImport = true;
    if (ts.isCallExpression(node) && serverPath(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) runtimeServerImport = true;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return runtimeServerImport;
}

describe("shared source isolation", () => {
  it("src/shared has no runtime import from @/server", () => {
    const offenders = files(path.join(process.cwd(), "src/shared")).filter((file) => {
      return hasRuntimeServerImport(readFileSync(file, "utf8"), file);
    });
    expect(offenders).toEqual([]);
  });

  it.each([
    'import "@/server/services/ask";',
    'export const load = () => import("@/server/services/ask");',
    'export const load = () => require("@/server/services/ask");',
    'export { ask } from "@/server/services/ask";',
  ])("detects a runtime server dependency: %s", (source) => {
    expect(hasRuntimeServerImport(source, "probe.ts")).toBe(true);
  });

  it("allows a type-only server import without runtime coupling", () => {
    expect(hasRuntimeServerImport('import type { T } from "@/server/core/types";', "probe.ts")).toBe(false);
  });
});
