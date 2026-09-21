// The network guard's escape hatch may be called ONLY from tests/setup/no-network.test.ts —
// anywhere else it would silently re-open live calls in tests. The name is spliced together so
// this file never matches its own grep.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const NAME = ["acknowledge", "Violations"].join("");
const SETUP_DIR = "tests/setup/";
const ONLY_CALLER = "tests/setup/no-network.test.ts";
const GUARD_MODULE = "tests/setup/no-network.ts";
const SCANNED_DIRS = ["src", "tests", "scripts"];
const GUARD_SPECIFIER = /(^|\/)no-network(\.ts)?$/;

interface SourceFile {
  file: string;
  source: string;
}

// Stricter than a repo-wide `grep -rn <name> src tests scripts`: the name may not appear at all
// outside tests/setup/, defined only in the guard module and imported from nowhere else (an
// aliased or namespace import would dodge a name search).
function checkEscapeHatch(files: SourceFile[]): { errors: string[]; callSites: string[] } {
  const errors: string[] = [];
  const callSites: string[] = [];
  for (const { file, source } of files) {
    const mentions = source.includes(NAME);
    if (mentions && !file.startsWith(SETUP_DIR)) errors.push(`${file}: names ${NAME} outside ${SETUP_DIR}`);
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) || (!mentions && !source.includes("no-network"))) continue;

    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const called =
          (ts.isIdentifier(callee) && callee.text === NAME) ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === NAME) ||
          (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === NAME);
        if (called) {
          callSites.push(`${file}:${line(node)}`);
          if (file !== ONLY_CALLER) errors.push(`${file}:${line(node)}: calls ${NAME} — only ${ONLY_CALLER} may`);
        }
        const [arg] = node.arguments;
        const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
        if (dynamic && arg && ts.isStringLiteralLike(arg) && GUARD_SPECIFIER.test(arg.text) && !file.startsWith(SETUP_DIR)) {
          errors.push(`${file}:${line(node)}: loads the network guard module outside ${SETUP_DIR}`);
        }
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (GUARD_SPECIFIER.test(node.moduleSpecifier.text) && !file.startsWith(SETUP_DIR)) {
          errors.push(`${file}:${line(node)}: imports the network guard module outside ${SETUP_DIR}`);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === NAME && file !== GUARD_MODULE) {
        errors.push(`${file}:${line(node)}: defines ${NAME} — only ${GUARD_MODULE} may`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  if (!callSites.some((site) => site.startsWith(`${ONLY_CALLER}:`))) errors.push(`positive control: no call to ${NAME} in ${ONLY_CALLER}`);
  return { errors, callSites };
}

function realTree(): SourceFile[] {
  const root = process.cwd();
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") })),
  );
}

describe("the real tree", () => {
  const { errors, callSites } = checkEscapeHatch(realTree());

  it(`${NAME} is called only from ${ONLY_CALLER}, and at least once there`, () => {
    expect(errors).toEqual([]);
    expect(callSites.length).toBeGreaterThanOrEqual(1);
    expect(callSites.every((site) => site.startsWith(`${ONLY_CALLER}:`))).toBe(true);
  });

  it("the scan really covers the tree (positive control: it reads the guard and this file)", () => {
    const files = realTree().map((f) => f.file);
    expect(files).toEqual(expect.arrayContaining([GUARD_MODULE, ONLY_CALLER, "tests/architecture/network-guard-scope.test.ts", "scripts/db-migrate.ts"]));
    expect(files.filter((f) => f.startsWith("src/")).length).toBeGreaterThan(100);
  });
});

describe("checkEscapeHatch catches each kind of scope violation", () => {
  const caller = { file: ONLY_CALLER, source: `import { ${NAME} } from "./no-network";\n${NAME}();\n` };

  it("the minimal legitimate world passes", () => {
    expect(checkEscapeHatch([caller]).errors).toEqual([]);
  });

  it("a call from a product test", () => {
    const rogue = { file: "src/server/llm/gemini.test.ts", source: `import { ${NAME} } from "../../../tests/setup/no-network";\n${NAME}();\n` };
    expect(checkEscapeHatch([caller, rogue]).errors).toEqual([
      `src/server/llm/gemini.test.ts: names ${NAME} outside tests/setup/`,
      "src/server/llm/gemini.test.ts:1: imports the network guard module outside tests/setup/",
      `src/server/llm/gemini.test.ts:2: calls ${NAME} — only ${ONLY_CALLER} may`,
    ]);
  });

  it("an aliased or namespace import that never spells the name", () => {
    const aliased = { file: "tests/integration/x.test.ts", source: `import * as guard from "../setup/no-network";\nconst ack = Object.values(guard)[0];\n` };
    const dynamic = { file: "scripts/y.ts", source: `await import("../tests/setup/no-network");\n` };
    expect(checkEscapeHatch([caller, aliased, dynamic]).errors).toEqual([
      "tests/integration/x.test.ts:1: imports the network guard module outside tests/setup/",
      "scripts/y.ts:1: loads the network guard module outside tests/setup/",
    ]);
  });

  it("a call from another tests/setup file — only the one file named above may call it", () => {
    const sibling = { file: "tests/setup/other.test.ts", source: `import { ${NAME} } from "./no-network";\n${NAME}();\n` };
    expect(checkEscapeHatch([caller, sibling]).errors).toEqual([`tests/setup/other.test.ts:2: calls ${NAME} — only ${ONLY_CALLER} may`]);
  });

  it("no call at all in the one allowed file (positive control fails)", () => {
    expect(checkEscapeHatch([{ file: ONLY_CALLER, source: "export {};\n" }]).errors).toEqual([`positive control: no call to ${NAME} in ${ONLY_CALLER}`]);
  });
});
