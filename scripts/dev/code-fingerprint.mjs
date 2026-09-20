// Prints "<sha256 of the comment-free TypeScript AST>  <path>" for every .ts/.tsx file under the given
// directories (default: src). Two runs print identical lines when an edit touched only comments or
// whitespace, which is how comment-only cleanups are proven behaviour-neutral.
//
// Usage: node scripts/dev/code-fingerprint.mjs [root] [dir...]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [rootArg = ".", ...dirs] = process.argv.slice(2);
const root = path.resolve(rootArg);
const ts = createRequire(path.join(root, "package.json"))("typescript");
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) yield* walk(file);
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith(".d.ts")) yield file;
  }
}

for (const dir of dirs.length > 0 ? dirs : ["src"]) {
  for (const file of [...walk(path.join(root, dir))].sort()) {
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, kind);
    const hash = createHash("sha256").update(printer.printFile(source)).digest("hex").slice(0, 16);
    console.log(`${hash}  ${path.relative(root, file)}`);
  }
}
