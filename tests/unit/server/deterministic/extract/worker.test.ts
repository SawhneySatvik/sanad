import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A `node:` builtin, or an unscoped package name with an optional subpath — a scoped name is
// indistinguishable from this repo's `@tests/` alias, so none is allowed until one is needed.
const BUILTIN_OR_PACKAGE = /^(node:[a-z_/]+|[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)*)$/;

function importSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  return source.statements
    .flatMap((statement) =>
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? [statement.moduleSpecifier] : [],
    )
    .filter((specifier): specifier is ts.StringLiteral => specifier !== undefined && ts.isStringLiteral(specifier))
    .map((specifier) => specifier.text);
}

// Node runs worker.mts unbundled under vitest and tsx, with no path-alias or extension resolution —
// an `@/…` or `./x` import there would fail only at runtime, as every PDF/DOCX extraction failing
// with "The document parser stopped unexpectedly."
describe("worker.mts imports", () => {
  it("the check rejects the imports that would break the unbundled worker", () => {
    for (const bad of ["@/server/core/errors", "./constants", "../normalize", "@tests/support/db"]) {
      expect(bad).not.toMatch(BUILTIN_OR_PACKAGE);
    }
  });

  it("imports only node: builtins and packages", () => {
    const specifiers = importSpecifiers(join(process.cwd(), "src", "server", "deterministic", "extract", "worker.mts"));
    expect(specifiers).toEqual(expect.arrayContaining(["node:worker_threads", "mammoth", "unpdf"]));
    for (const specifier of specifiers) {
      expect(specifier).toMatch(BUILTIN_OR_PACKAGE);
    }
  });
});
