// The scanner behind verified-badge-single-source.verify.test.ts. Three independent checks, not
// one grep with a loophole: a file using the Tailwind utility `text-verified` with a different
// icon, or the reserved icon imported under one of its several export names, would each separately
// pass a conjunctive check while still being a second, unaudited renderer of "verified." Any ONE of
// the three trips it.
//
// Every check here walks the real TypeScript AST (or, for CSS, the file's own text with comments
// stripped) — never the raw source text of a .tsx file — so a mention of the word inside a //  or
// /* */ comment (prose explaining this very guarantee, say) is never itself a hit.

import ts from "typescript";
import * as lucide from "lucide-react";

export const VERIFICATION_BADGE_FILE = "src/components/verification/verification-badge.tsx";
export const GLOBALS_CSS_FILE = "src/app/globals.css";

// The reserved icon's own component, plus every other export name lucide-react happens to alias it
// under — computed from the real package rather than hand-typed, so a future lucide upgrade adding
// yet another alias is still caught instead of silently slipping past a stale hard-coded list.
const RESERVED_ICON_EXPORT_NAMES = new Set(Object.keys(lucide).filter((key) => (lucide as Record<string, unknown>)[key] === lucide.BadgeCheck));

function isLucideSpecifier(text: string): boolean {
  // A bare "lucide-react-native" (or any other package merely prefixed by the name) is not this
  // package — only the exact specifier or one of its own sub-paths counts.
  return text === "lucide-react" || text.startsWith("lucide-react/");
}

// A whole class token, once Tailwind's own non-colour decorations around the shape this test cares
// about are stripped: leading variant prefixes (hover:, dark:, sm:hover: ...), a leading "!"
// (important-first syntax), a trailing opacity modifier (/90) and a trailing "!" (important-last
// syntax) — none of these change *which* colour token the class names, only how/when it applies.
function stripDecorations(token: string): string {
  return token.replace(/^([^:]+:)*!?/, "").replace(/(\/\S+|!)$/, "");
}

// Ordinary English can otherwise coincidentally take the exact shape a real Tailwind colour utility
// would ("re-verified", "pre-verified" as one flowing word, with no Tailwind namespace of its own)
// — no genuine verified-family utility carries one of these ordinary-English prefixes, so excluding
// them costs no real coverage while closing off the false positive the previous scanner was burned
// by ("re-verified" in prose).
const PROSE_PREFIX_RE = /^(?:re|pre|un|non|self)-/;

const TAILWIND_VERIFIED_CLASS_RE = /^(?:[a-z]+-)+verified(?:-surface)?$/;
// Tailwind v4's own bracketless arbitrary-value syntax (bg-(--color-verified-surface),
// text-(--verified)) referencing the token by its own custom-property name directly on the utility —
// distinct from a raw CSS var() call, which CSS_VAR_VERIFIED_RE below already covers.
const PARENS_VAR_RE = /\(--(?:color-)?verified(?:-surface)?\b/;
const CSS_VAR_VERIFIED_RE = /var\(--(?:color-)?verified(?:-surface)?\b/;

function isVerifiedClassToken(rawToken: string): boolean {
  const token = stripDecorations(rawToken);
  if (PROSE_PREFIX_RE.test(token)) return false;
  return TAILWIND_VERIFIED_CLASS_RE.test(token) || PARENS_VAR_RE.test(token);
}

export interface FileViolation {
  file: string;
  reasons: string[];
}

// Every class-merge helper this codebase uses to build a class string — cn/clsx compose others'
// output, cva/tv build variant maps, twMerge resolves conflicting utilities — walked into every
// nested array/object literal argument, since cva's own "variants" config nests its class strings
// two or three object levels deep.
const CLASS_HELPER_NAMES = new Set(["cn", "clsx", "cva", "twMerge", "tv"]);

function collectStringLiteralText(expr: ts.Expression, out: string[]): void {
  if (ts.isStringLiteralLike(expr)) {
    out.push(expr.text);
  } else if (ts.isTemplateExpression(expr)) {
    out.push(expr.head.text, ...expr.templateSpans.map((span) => span.literal.text));
  } else if (ts.isConditionalExpression(expr)) {
    collectStringLiteralText(expr.whenTrue, out);
    collectStringLiteralText(expr.whenFalse, out);
  } else if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    collectStringLiteralText(expr.left, out);
    collectStringLiteralText(expr.right, out);
  } else if (ts.isParenthesizedExpression(expr)) {
    collectStringLiteralText(expr.expression, out);
  } else if (ts.isArrayLiteralExpression(expr)) {
    for (const element of expr.elements) {
      if (!ts.isSpreadElement(element)) collectStringLiteralText(element, out);
    }
  } else if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop)) collectStringLiteralText(prop.initializer, out);
    }
  } else if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && CLASS_HELPER_NAMES.has(expr.expression.text)) {
    expr.arguments.forEach((arg) => collectStringLiteralText(arg, out));
  }
}

// Walks every string/template literal that plausibly holds a class list: a JSX className attribute;
// any argument to a class-merge helper, wherever it's called from (a className attribute often
// wraps one, but a class string can just as easily be built once and assigned to a plain `const`
// elsewhere); and a bare `const NAME = "..."` whose initializer is itself a literal, since a class
// list never has to pass through a helper at all to be real.
function classListLiterals(sourceFile: ts.SourceFile): string[] {
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "className" && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) literals.push(node.initializer.text);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) collectStringLiteralText(node.initializer.expression, literals);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_HELPER_NAMES.has(node.expression.text)) {
      collectStringLiteralText(node, literals);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      collectStringLiteralText(node.initializer, literals);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

function hasVerifiedClassToken(sourceFile: ts.SourceFile): boolean {
  return classListLiterals(sourceFile).some((literal) => literal.split(/\s+/).some((token) => isVerifiedClassToken(token)));
}

// Any of: a named import of the reserved icon under any of its export names, from the flat package
// specifier; a namespace import of the whole package (which can reach the icon under any name
// without a matching named-import specifier this scan could otherwise key on); an import — default,
// named or namespace alike — from a DEEP sub-path (lucide-react/dist/esm/icons/badge-check): nothing
// in this codebase ever imports an icon that way, so any import reaching into the package's own
// internals is itself the violation regardless of which local name it binds the icon under; a
// specifier naming the package (bare or deep) from a dynamic `import()` or a `require()`; and a
// re-export of the icon (`export { BadgeCheck } from "lucide-react"`, `export * from "lucide-react"`,
// `export * as Icons from "lucide-react"`) — the export-side twin of an import.
function importsReservedIcon(sourceFile: ts.SourceFile): boolean {
  let found = false;

  const flagIfReserved = (name: string) => {
    if (RESERVED_ICON_EXPORT_NAMES.has(name)) found = true;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (isLucideSpecifier(specifier) && clause && !clause.isTypeOnly) {
        if (specifier !== "lucide-react") {
          found = true;
        } else {
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) found = true;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (!element.isTypeOnly) flagIfReserved((element.propertyName ?? element.name).text);
            }
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && !node.isTypeOnly) {
      const specifier = node.moduleSpecifier.text;
      if (isLucideSpecifier(specifier)) {
        if (specifier !== "lucide-react") {
          found = true;
        } else if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
          found = true; // `export * from "lucide-react"` or `export * as Icons from "lucide-react"`
        } else if (ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            if (!element.isTypeOnly) flagIfReserved((element.propertyName ?? element.name).text);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg) && isLucideSpecifier(arg.text)) found = true;
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

// A leading checkmark glyph ("✓ Verified") is decoration around the same label, not different text.
const CHECK_GLYPH_RE = /^[✓✔]\s*/;

function normalizeLabelCandidate(raw: string): string {
  return raw.trim().replace(CHECK_GLYPH_RE, "").trim().toLowerCase();
}

function isExactVerifiedLabel(raw: string): boolean {
  return normalizeLabelCandidate(raw) === "verified";
}

// A JSX text child, a bare string-literal JSX expression child ({"Verified"}), or an aria-label/title
// attribute, whose normalized text is EXACTLY "verified" (case-insensitive, a leading check glyph and
// surrounding whitespace ignored) — never a substring match, so a sentence like "Verified means
// verified" (mentioning the word in prose) or an aria-label sentence that happens to use the word
// ("Jump to citation in Document A, verified") is never flagged.
function hasExactVerifiedJsxText(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && isExactVerifiedLabel(node.text)) found = true;
    if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression) && isExactVerifiedLabel(node.expression.text)) found = true;
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile).toLowerCase();
      if ((name === "aria-label" || name === "title") && node.initializer) {
        if (ts.isStringLiteral(node.initializer) && isExactVerifiedLabel(node.initializer.text)) found = true;
        if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression &&
          ts.isStringLiteralLike(node.initializer.expression) &&
          isExactVerifiedLabel(node.initializer.expression.text)
        ) {
          found = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

// A CSS token stream, split on the delimiters that separate class-like tokens in either a selector
// or an `@apply` list — deliberately NOT splitting on "(" / ")" or ":", since both survive as part of
// a single token (stripDecorations expects a leading "foo:" variant prefix intact, and the
// bracketless arbitrary-value form needs its own parens intact).
function cssTokens(text: string): string[] {
  return text
    .split(/[\s;{},]+/)
    .filter(Boolean)
    .map((token) => token.replace(/^\.+/, ""));
}

function verifiedFamilyCssHit(source: string): boolean {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  if (CSS_VAR_VERIFIED_RE.test(stripped)) return true;
  return cssTokens(stripped).some((token) => isVerifiedClassToken(token));
}

/** Violations in one file's source, or [] if this file is exempt or clean. relativePath uses "/" separators. */
export function findViolationsInFile(relativePath: string, source: string): string[] {
  if (relativePath === VERIFICATION_BADGE_FILE || relativePath === GLOBALS_CSS_FILE) return [];

  const reasons: string[] = [];

  if (relativePath.endsWith(".css")) {
    if (verifiedFamilyCssHit(source)) {
      reasons.push("references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)");
    }
    return reasons;
  }

  if (/\.tsx?$/.test(relativePath)) {
    const scriptKind = relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    if (CSS_VAR_VERIFIED_RE.test(source) || hasVerifiedClassToken(sourceFile)) {
      reasons.push("references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)");
    }
    if (importsReservedIcon(sourceFile)) reasons.push("imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)");
    if (hasExactVerifiedJsxText(sourceFile)) reasons.push('renders the literal JSX text "Verified"');
  }

  return reasons;
}

export function findViolations(files: Record<string, string>): FileViolation[] {
  const violations: FileViolation[] = [];
  for (const [file, source] of Object.entries(files)) {
    const reasons = findViolationsInFile(file, source);
    if (reasons.length > 0) violations.push({ file, reasons });
  }
  return violations;
}
