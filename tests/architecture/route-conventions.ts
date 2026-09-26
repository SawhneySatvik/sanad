// Static checks behind the route-layer conventions, parsed with the TypeScript compiler. checkRouteSource:
// every route.ts is a thin adapter making exactly one service-layer call. checkViewSource: every
// view mapper is pure. checkSpanTextWrites: only verification.ts may construct a spanText key.

import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const ROUTES_ROOT = path.join(process.cwd(), "src", "app", "api");
export const HTTP_ROOT = path.join(process.cwd(), "src", "server", "http");
export const VIEWS_ROOT = path.join(HTTP_ROOT, "views");
export const VERIFICATION_MAPPER = "src/server/http/verification.ts";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SEGMENT_CONFIG = new Set(["dynamic", "maxDuration", "runtime"]);
const RUN_BINDINGS = new Set(["deps", "principal", "params", "query", "body", "claim", "signal"]);

// Claim needs both the auth-hook user and signed guest identity; delete-all clears the guest cookie
// after erasing its data. Pinning these routes keeps cookie side effects out of ordinary handlers.
export const CLAIM_ROUTE = "src/app/api/auth/claim/route.ts";
const CLAIM_OPT_INS = new Set(["claimSession", "clearsGuestSession"]);
export const DELETE_ALL_ROUTE = "src/app/api/me/data/route.ts";

// The routes allowed to opt into route()'s userSession cookie mechanism (src/server/http/handler.ts):
// dev-sign-in mints the dev cookie, sign-in/sign-up mint the real account cookie, sign-out clears
// both. Any other route naming `userSession` at all is a violation — the property name is checked,
// not its "set"/"set-account"/"clear" value, mirroring CLAIM_OPT_INS.
export const USER_SESSION_SET_ROUTE = "src/app/api/auth/dev-sign-in/route.ts";
export const USER_SESSION_CLEAR_ROUTE = "src/app/api/session/sign-out/route.ts";
export const USER_SESSION_SIGN_IN_ROUTE = "src/app/api/auth/sign-in/route.ts";
export const USER_SESSION_SIGN_UP_ROUTE = "src/app/api/auth/sign-up/route.ts";
const USER_SESSION_OPT_IN_ROUTES = new Set([
  USER_SESSION_SET_ROUTE,
  USER_SESSION_CLEAR_ROUTE,
  USER_SESSION_SIGN_IN_ROUTE,
  USER_SESSION_SIGN_UP_ROUTE,
]);

// clearsGuestSession alone (never claimSession) is also allowed on delete-all and on sign-in/sign-up:
// a fresh account just claimed the guest's data, so a later sign-out must never hand the same guest
// id back out on a shared device.
const CLEARS_GUEST_SESSION_ALSO_ALLOWED = new Set([DELETE_ALL_ROUTE, USER_SESSION_SIGN_IN_ROUTE, USER_SESSION_SIGN_UP_ROUTE]);

// The one route that resolves no caller identity (route()'s `principal: "none"`): no IP-tier charge,
// no guest session minted. Any other route opting out would skip both.
export const ANONYMOUS_ROUTE = "src/app/api/health/route.ts";

// The only @/server/http plumbing a route file may import by value — none of it calls a service.
export const ROUTE_PLUMBING: Record<string, readonly string[]> = {
  "@/server/http/handler": ["route"],
  "@/server/http/uploads": ["withRelayUrl", "verifyRelayToken", "MAX_RELAY_UPLOAD_BYTES"],
  "@/server/http/health": ["checkHealth"],
};
const SERVICE_MODULE = /^@\/server\/(services|data)\/[\w.-]+$/;
const CONTRACT_MODULE = /^@\/shared\/contracts\/[\w-]+$/;
const VIEW_MODULE = /^@\/server\/http\/views\/[\w-]+$/;
const VIEW_ALLOWED_VALUE_IMPORT = /^(zod|@\/shared\/contracts\/[\w-]+|@\/server\/core\/[\w-]+|@\/server\/http\/verification|@\/server\/http\/views\/[\w-]+)$/;
const VIEW_PURE_DETERMINISTIC_IMPORTS = new Set([
  "@/server/deterministic/sanitize/model-text",
  "@/server/deterministic/draft-templates",
]);

// Repo-relative path → why the route calls no service function.
export const ZERO_SERVICE_ROUTES: Record<string, string> = {
  "src/app/api/health/route.ts":
    "docs/API.md: 'no LLM call' — a config read, not a feature surface",
};

export function findFiles(dir: string, match: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return findFiles(full, match);
    return match(entry.name) ? [full] : [];
  });
}

export function findRouteFiles(dir: string = ROUTES_ROOT): string[] {
  return findFiles(dir, (name) => /^route\.(ts|tsx|js|mjs)$/.test(name));
}

export const isSourceFile = (name: string): boolean => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name);

export function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

// A regex cannot see where a handler ends, nor through aliases, destructuring or element access.
function parse(relativePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

// "./x" and "../x" resolved against the importing file, then written as the "@/..." alias.
function normalizeSpecifier(relativePath: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
  return resolved.startsWith("src/") ? `@/${resolved.slice(4)}` : resolved;
}

// Value (non-type) names an import binds, and the names it imports them as.
function valueBindings(declaration: ts.ImportDeclaration): { local: string; imported: string }[] {
  const clause = declaration.importClause;
  if (!clause || clause.isTypeOnly) return [];
  const names: { local: string; imported: string }[] = [];
  if (clause.name) names.push({ local: clause.name.text, imported: "default" });
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push({ local: bindings.name.text, imported: "*" });
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) names.push({ local: element.name.text, imported: (element.propertyName ?? element.name).text });
    }
  }
  return names;
}

function dynamicLoadViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push("uses a dynamic import()");
    if (ts.isIdentifier(node.expression) && node.expression.text === "require") violations.push("uses require()");
  });
  return violations;
}

function isPropertyNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

// An identifier, a quoted key or a computed string-literal key, as written.
function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

function isInsideFunction(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return true;
  }
  return false;
}

function isLiteralValue(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    (ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword)
  );
}

// deps.storage.<method>(...) — the callee `deps.storage.<method>` of a call.
function isStorageCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const target = callee.expression;
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "storage" &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "deps"
  );
}

// The call a service reference is the callee of — `svc(...)` or `ns.fn(...)` — or null.
function callOfServiceReference(node: ts.Identifier): ts.CallExpression | null {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return parent;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return parent.parent;
  }
  return null;
}

// Why a call is not directly in run's body (a nested function, a loop, or outside run), or null.
function placementProblem(call: ts.Node, run: ts.ArrowFunction): string | null {
  for (let node: ts.Node = call.parent; node; node = node.parent) {
    if (node === run) return null;
    if (ts.isFunctionLike(node)) return "inside a nested function";
    if (ts.isIterationStatement(node, false)) return "inside a loop";
  }
  return "outside run";
}

// `run` must be an arrow function destructuring only { deps, principal, params, query, body } by
// name, making exactly ONE service-layer call directly in its body (Health is the one route with
// none — ZERO_SERVICE_ROUTES). `deps` may only be handed to that call, never read any other way.
function checkHandler(
  name: string,
  initializer: ts.Expression,
  serviceNames: Set<string>,
  expectedCalls: number,
  isClaimRoute: boolean,
): string[] {
  const violations: string[] = [];
  const spec = ts.isCallExpression(initializer) ? initializer.arguments[0] : undefined;
  if (!spec || !ts.isObjectLiteralExpression(spec)) return violations;

  const runProperty = spec.properties.find(
    (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "run",
  );
  const run = runProperty && ts.isPropertyAssignment(runProperty) ? runProperty.initializer : undefined;
  if (!run || !ts.isArrowFunction(run)) return [`${name}: run must be an arrow function`];

  const [argument] = run.parameters;
  const bindsClaim =
    argument !== undefined &&
    ts.isObjectBindingPattern(argument.name) &&
    argument.name.elements.some((e) => ts.isIdentifier(e.name) && e.name.text === "claim");
  if (bindsClaim && !isClaimRoute) violations.push(`${name}: only ${CLAIM_ROUTE} receives claim`);
  if (argument) {
    const pattern = argument.name;
    const plain =
      ts.isObjectBindingPattern(pattern) &&
      pattern.elements.every(
        (e) => !e.dotDotDotToken && !e.initializer && !e.propertyName && ts.isIdentifier(e.name) && RUN_BINDINGS.has(e.name.text),
      );
    if (!plain) violations.push(`${name}: run destructures only { deps, principal, params, query, body }, by name`);
  }

  const serviceCalls = new Set<ts.CallExpression>();
  walk(spec, (node) => {
    if (ts.isCallExpression(node) && isStorageCall(node)) serviceCalls.add(node);
    if (!ts.isIdentifier(node) || !serviceNames.has(node.text) || isPropertyNamePosition(node)) return;
    const call = callOfServiceReference(node);
    if (call) serviceCalls.add(call);
    else violations.push(`${name}: references ${node.text} without calling it directly`);
  });
  for (const call of serviceCalls) {
    const problem = placementProblem(call, run);
    if (problem) violations.push(`${name}: a service call ${problem} — make it directly in run's body`);
  }
  if (serviceCalls.size !== expectedCalls) {
    violations.push(`${name} makes ${serviceCalls.size} service-layer calls; exactly ${expectedCalls} expected`);
  }

  walk(run.body, (node) => {
    if (!ts.isIdentifier(node) || node.text !== "deps" || isPropertyNamePosition(node)) return;
    const parent = node.parent;
    const passedToServiceCall = ts.isCallExpression(parent) && serviceCalls.has(parent) && parent.arguments.includes(node);
    const dbPassedToServiceCall =
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "db" &&
      ts.isCallExpression(parent.parent) &&
      serviceCalls.has(parent.parent) &&
      parent.parent.arguments.includes(parent);
    const storageCall =
      ts.isPropertyAccessExpression(parent) &&
      ts.isPropertyAccessExpression(parent.parent) &&
      ts.isCallExpression(parent.parent.parent) &&
      isStorageCall(parent.parent.parent);
    if (!passedToServiceCall && !dbPassedToServiceCall && !storageCall) {
      violations.push(`${name}: uses deps other than handing it to its one service call — that is service work`);
    }
  });
  return violations;
}

// Top level holds only imports, `export const <METHOD> = route({...})` handlers and literal
// segment config; value imports come only from the service layer, contracts, view mappers and
// ROUTE_PLUMBING — no other @/server/http module, no db/storage/llm/rate-limit/auth, no dynamic load.
export function checkRouteSource(relativePath: string, source: string): string[] {
  const sourceFile = parse(relativePath, source);
  const violations = dynamicLoadViolations(sourceFile);
  const isClaimRoute = relativePath === CLAIM_ROUTE;
  if (!isClaimRoute) {
    walk(sourceFile, (node) => {
      const named =
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        CLAIM_OPT_INS.has(propertyNameText(node.name) ?? "");
      const key =
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        propertyNameText(node.name)
          ? propertyNameText(node.name)!
          : null;
      if (named && !(key === "clearsGuestSession" && CLEARS_GUEST_SESSION_ALSO_ALLOWED.has(relativePath))) {
        violations.push(`only ${CLAIM_ROUTE} may opt into claimSession / clearsGuestSession`);
      }
    });
  }
  if (!USER_SESSION_OPT_IN_ROUTES.has(relativePath)) {
    walk(sourceFile, (node) => {
      // propertyNameText also resolves a computed key (["userSession"]: ...), unlike the identifier/
      // string-literal check CLAIM_OPT_INS uses above — a computed key would otherwise slip past.
      const named =
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        propertyNameText(node.name) === "userSession";
      if (named) {
        violations.push(`only ${USER_SESSION_SET_ROUTE} or ${USER_SESSION_CLEAR_ROUTE} may opt into userSession`);
      }
    });
  }
  if (relativePath !== ANONYMOUS_ROUTE) {
    walk(sourceFile, (node) => {
      // Inside a function it is an object built per request (e.g. `{ principal }` handed to a
      // service), never a route() spec.
      const specKey =
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        propertyNameText(node.name) === "principal" &&
        !isInsideFunction(node);
      if (specKey) violations.push(`only ${ANONYMOUS_ROUTE} may opt out of the principal (principal: "none")`);
    });
  }
  const serviceNames = new Set<string>();
  let routeImported = false;
  const handlers: { name: string; initializer: ts.Expression }[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (!statement.importClause) {
        violations.push(`side-effect import "${specifier}"`);
        continue;
      }
      const names = valueBindings(statement);
      if (names.length === 0) continue;
      if (SERVICE_MODULE.test(specifier)) {
        for (const { local } of names) serviceNames.add(local);
      } else if (specifier in ROUTE_PLUMBING) {
        for (const { local, imported } of names) {
          if (!ROUTE_PLUMBING[specifier].includes(imported)) {
            violations.push(`imports ${imported} from "${specifier}" — not route plumbing (see ROUTE_PLUMBING)`);
          }
          if (specifier === "@/server/http/handler" && imported === "route" && local === "route") routeImported = true;
        }
      } else if (!CONTRACT_MODULE.test(specifier) && !VIEW_MODULE.test(specifier)) {
        violations.push(
          `imports "${specifier}" — route files import only services/data, contracts, views and ROUTE_PLUMBING`,
        );
      }
      continue;
    }

    const exported =
      ts.isVariableStatement(statement) &&
      (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "(destructured)";
        if (HTTP_METHODS.has(name) && declaration.initializer) {
          handlers.push({ name, initializer: declaration.initializer });
        } else if (name === "runtime") {
          const value = declaration.initializer;
          if (!value || !ts.isStringLiteral(value) || value.text !== "nodejs") {
            violations.push('runtime must be the literal "nodejs" — never the edge runtime (CLAUDE.md: no edge runtime for DB/LLM routes)');
          }
        } else if (SEGMENT_CONFIG.has(name)) {
          if (!isLiteralValue(declaration.initializer)) violations.push(`${name} must be a literal`);
        } else {
          violations.push(`exports "${name}" — a route file exports only HTTP-method handlers and segment config`);
        }
      }
      continue;
    }

    violations.push(
      `top-level ${ts.SyntaxKind[statement.kind]} — a route file holds only imports, route() handlers and segment config`,
    );
  }

  if (handlers.length === 0) violations.push("exports no HTTP-method handler built with route()");
  const expected = relativePath in ZERO_SERVICE_ROUTES ? 0 : 1;
  for (const { name, initializer } of handlers) {
    const builtWithRoute =
      routeImported &&
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === "route" &&
      initializer.arguments.length === 1 &&
      ts.isObjectLiteralExpression(initializer.arguments[0]);
    if (!builtWithRoute) {
      violations.push(`${name} is not built with route({...}) from @/server/http/handler — it would skip the IP tier`);
      continue;
    }
    violations.push(...checkHandler(name, initializer, serviceNames, expected, isClaimRoute));
  }
  return violations;
}

export function checkViewSource(relativePath: string, source: string): string[] {
  const sourceFile = parse(relativePath, source);
  const violations = dynamicLoadViolations(sourceFile);
  for (const statement of sourceFile.statements) {
    let bindsValues: boolean;
    if (ts.isImportDeclaration(statement)) bindsValues = !statement.importClause || valueBindings(statement).length > 0;
    else if (ts.isExportDeclaration(statement)) bindsValues = !statement.isTypeOnly;
    else continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    const specifier = normalizeSpecifier(relativePath, moduleSpecifier.text);
    if (bindsValues && !VIEW_ALLOWED_VALUE_IMPORT.test(specifier) && !VIEW_PURE_DETERMINISTIC_IMPORTS.has(specifier)) {
      violations.push(
        `imports "${moduleSpecifier.text}" by value — a view is a pure mapper (contracts, core, verification, views and two pure deterministic helpers only)`,
      );
    }
  }
  return violations;
}

function isSpanTextName(name: ts.PropertyName | undefined): boolean {
  if (!name) return false;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === "spanText";
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) && name.expression.text === "spanText";
}

export function checkSpanTextWrites(relativePath: string, source: string): string[] {
  const violations: string[] = [];
  walk(parse(relativePath, source), (node) => {
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      isSpanTextName(node.name)
    ) {
      violations.push("constructs a spanText key — only toVerificationOutput (src/server/http/verification.ts) may");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "spanText"
    ) {
      violations.push("assigns spanText — only toVerificationOutput (src/server/http/verification.ts) may");
    }
    // Catches element access (o["spanText"] = …), defineProperty, fromEntries — not a type, and not
    // a literal property name (already reported above).
    if (ts.isStringLiteralLike(node) && node.text === "spanText") {
      const parent = node.parent;
      const isKeyName = ts.isComputedPropertyName(parent) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (ts.isLiteralTypeNode(parent) || isKeyName) return;
      violations.push('uses the key "spanText" as a value — only toVerificationOutput (src/server/http/verification.ts) may');
    }
  });
  return violations;
}
