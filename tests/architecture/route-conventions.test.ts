// Static gate run over the real tree (every route file, view and route-layer module, including
// ones added later), proven against known-bad sources — among them eight known bypass techniques.
// See ./route-conventions.ts for the rules.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_ROUTE,
  CLAIM_ROUTE,
  checkRouteSource,
  checkSpanTextWrites,
  checkViewSource,
  findFiles,
  findRouteFiles,
  HTTP_ROOT,
  isSourceFile,
  repoRelative,
  ROUTES_ROOT,
  USER_SESSION_CLEAR_ROUTE,
  USER_SESSION_SET_ROUTE,
  VERIFICATION_MAPPER,
  VIEWS_ROOT,
  ZERO_SERVICE_ROUTES,
} from "./route-conventions";

const T115A_ROUTES = [
  "src/app/api/health/route.ts",
  "src/app/api/uploads/route.ts",
  "src/app/api/uploads/relay/route.ts",
  "src/app/api/documents/route.ts",
  "src/app/api/documents/[id]/route.ts",
  "src/app/api/documents/[id]/analyze/route.ts",
];

const read = (file: string) => readFileSync(file, "utf8");
const asCases = (files: string[]) => files.map((file) => [repoRelative(file), file]);

describe("the real tree", () => {
  const routes = findRouteFiles();

  it("finds every route file — at least the six routes checked below", () => {
    expect(routes.map(repoRelative)).toEqual(expect.arrayContaining(T115A_ROUTES));
  });

  it.each(asCases(routes))("route %s follows the route conventions", (name, file) => {
    expect(checkRouteSource(name, read(file))).toEqual([]);
  });

  it("the zero-service allowlist names only files that exist", () => {
    for (const file of Object.keys(ZERO_SERVICE_ROUTES)) expect(routes.map(repoRelative)).toContain(file);
  });

  const views = findFiles(VIEWS_ROOT, isSourceFile);

  it("finds the view mappers — at least the document view", () => {
    expect(views.map(repoRelative)).toContain("src/server/http/views/document-view.ts");
  });

  it.each(asCases(views))("view %s is a pure mapper", (name, file) => {
    expect(checkViewSource(name, read(file))).toEqual([]);
  });

  const routeLayer = [...findFiles(HTTP_ROOT, isSourceFile), ...findFiles(ROUTES_ROOT, isSourceFile)];

  it.each(asCases(routeLayer.filter((file) => repoRelative(file) !== VERIFICATION_MAPPER)))(
    "%s constructs no spanText (only toVerificationOutput may)",
    (name, file) => {
      expect(checkSpanTextWrites(name, read(file))).toEqual([]);
    },
  );

  it("the spanText check does fire on the one file allowed to construct it (positive control)", () => {
    const mapper = routeLayer.find((file) => repoRelative(file) === VERIFICATION_MAPPER);
    expect(mapper).toBeDefined();
    expect(checkSpanTextWrites(VERIFICATION_MAPPER, read(mapper!))).not.toEqual([]);
  });

  // The principal tier is charged per LLM call inside deps.llm; a second, per-request charge in the
  // route layer would double-charge every LLM route. Recurses into src/server/http/**.
  it.each(asCases(routeLayer))("%s never charges the principal tier itself", (_name, file) => {
    expect(read(file)).not.toMatch(/\b(enforce|check)(Principal|PrincipalDaily|IpLlm|IpLlmDaily)Limit\b|\bwith(Principal|Caller)Limit\b/);
  });

  it("the principal-limit scan reaches the views subdirectory", () => {
    expect(routeLayer.map(repoRelative)).toContain("src/server/http/views/document-view.ts");
  });
});

const FILE = "src/app/api/example/[id]/route.ts";
const header = `import { route } from "@/server/http/handler";
import * as understand from "@/server/services/understand";
import { IdParams } from "@/shared/contracts/common";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";
`;
const handler = (run: string, extra = "") =>
  `${header}${extra}
export const GET = route({ params: IdParams, response: DocumentWithFindingsOutput, run: ${run} });
`;
const one = "({ deps, principal, params }) => understand.get(deps, principal, params.id)";

describe("known bypass techniques are each caught", () => {
  // Each probe is a second service call smuggled past the route-conventions gate one way or another.
  const probes: [string, string, string][] = [
    [
      "element access on deps.storage",
      handler(`async ({ deps, principal, params }) => { await deps["storage"].delete(principal, { storageRef: "x" } as never); return understand.get(deps, principal, params.id); }`),
      "GET: uses deps other than handing it to its one service call — that is service work",
    ],
    [
      "renamed destructuring of storage",
      handler(`async ({ deps: { storage: s }, deps, principal, params }) => { await s.delete(principal, {} as never); return understand.get(deps, principal, params.id); }`),
      "GET: run destructures only { deps, principal, params, query, body }, by name",
    ],
    [
      "element access on deps.db",
      handler(`async ({ deps, principal, params }) => { await deps["db"].execute("delete from documents" as never); return understand.get(deps, principal, params.id); }`),
      "GET: uses deps other than handing it to its one service call — that is service work",
    ],
    [
      "renamed destructuring of db",
      handler(`async ({ deps: { db: d }, deps, principal, params }) => { await d.execute("x" as never); return understand.get(deps, principal, params.id); }`),
      "GET: run destructures only { deps, principal, params, query, body }, by name",
    ],
    [
      "a dynamic import of a second service",
      handler(`async ({ deps, principal, params }) => { const ask = await import("@/server/services/ask"); await ask.ask(deps as never, principal, {} as never); return understand.get(deps, principal, params.id); }`),
      "uses a dynamic import()",
    ],
    [
      "a second call hidden in an @/server/http helper",
      handler(
        `async ({ deps, principal, params }) => { await secondService(deps, principal, params.id); return understand.get(deps, principal, params.id); }`,
        `import { secondService } from "@/server/http/some-helper";\n`,
      ),
      'imports "@/server/http/some-helper" — route files import only services/data, contracts, views and ROUTE_PLUMBING',
    ],
    [
      "an edge runtime written as a template literal",
      `${handler(one)}export const runtime = \`edge\`;\n`,
      'runtime must be the literal "nodejs" — never the edge runtime (CLAUDE.md: no edge runtime for DB/LLM routes)',
    ],
    [
      "one reference called many times in a loop callback",
      handler(`async ({ deps, principal, params }) => Promise.all([1,2,3].map(() => understand.analyzeDocument(deps, principal, params.id)))`),
      "GET: a service call inside a nested function — make it directly in run's body",
    ],
  ];

  it.each(probes)("%s", (_label, source, violation) => {
    expect(checkRouteSource(FILE, source)).toContain(violation);
  });
});

describe("checkRouteSource catches each violation", () => {
  it("passes a conforming route (positive control)", () => {
    expect(checkRouteSource(FILE, handler(one))).toEqual([]);
  });

  it("passes a repository route handing deps.db to its one repository call", () => {
    const source = `import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { ProjectsListOutput } from "@/shared/contracts/projects";
export const GET = route({ response: ProjectsListOutput, run: ({ deps, principal }) => projects.listForPrincipal(deps.db, principal) });
`;
    expect(checkRouteSource("src/app/api/projects/route.ts", source)).toEqual([]);
  });

  it("passes the upload shape: plumbing plus one deps.storage call", () => {
    const source = `import { route } from "@/server/http/handler";
import { MAX_RELAY_UPLOAD_BYTES, verifyRelayToken } from "@/server/http/uploads";
import { UploadRelayOutput, UploadRelayQuery } from "@/shared/contracts/uploads";
export const PUT = route({ query: UploadRelayQuery, body: "file", maxBodyBytes: MAX_RELAY_UPLOAD_BYTES, response: UploadRelayOutput,
  run: async ({ deps, principal, query, body }) => { const ref = verifyRelayToken(query.token); await deps.storage.writeRelayed(principal, ref, body); return { ref }; } });
`;
    expect(checkRouteSource("src/app/api/uploads/relay/route.ts", source)).toEqual([]);
  });

  it("two service calls in one handler", () => {
    const run = `async ({ deps, principal, params }) => {
      await understand.analyzeDocument(deps, principal, params.id);
      return understand.get(deps, principal, params.id);
    }`;
    expect(checkRouteSource(FILE, handler(run))).toEqual(["GET makes 2 service-layer calls; exactly 1 expected"]);
  });

  it("no service call in a route that is not allowlisted", () => {
    expect(checkRouteSource(FILE, handler("async () => ({})"))).toEqual(["GET makes 0 service-layer calls; exactly 1 expected"]);
  });

  it("an aliased service function", () => {
    const source = `import { route } from "@/server/http/handler";
import { get as load } from "@/server/services/understand";
import { IdParams } from "@/shared/contracts/common";
export const GET = route({ params: IdParams, response: IdParams, run: async ({ deps, principal, params }) => {
  const again = load;
  await load(deps, principal, params.id);
  return again(deps, principal, params.id);
} });
`;
    expect(checkRouteSource(FILE, source)).toContain("GET: references load without calling it directly");
  });

  it("a second storage call", () => {
    const run = `async ({ deps, principal, body }) => {
      const target = await deps.storage.createUploadTarget(principal, body);
      await deps.storage.writeRelayed(principal, target.ref, new Uint8Array(1));
      return target;
    }`;
    expect(checkRouteSource(FILE, handler(run))).toContain("GET makes 2 service-layer calls; exactly 1 expected");
  });

  it("a service call in a loop, or outside run", () => {
    const loop = `async ({ deps, principal, params }) => { for (const _ of [1]) await understand.get(deps, principal, params.id); }`;
    const outside = `${header}
export const GET = route({ params: IdParams, response: understand.get(null as never, null as never, ""), run: async () => ({}) });
`;
    expect(checkRouteSource(FILE, handler(loop))).toContain("GET: a service call inside a loop — make it directly in run's body");
    expect(checkRouteSource(FILE, outside)).toContain("GET: a service call outside run — make it directly in run's body");
  });

  it("deps used any other way: db/llm member access, spread, aliasing", () => {
    const cases = [
      "async ({ deps, principal, params }) => { await deps.db.select(); return understand.get(deps, principal, params.id); }",
      "async ({ deps, principal, params }) => { await deps.llm.complete({} as never); return understand.get(deps, principal, params.id); }",
      "async ({ deps, principal, params }) => understand.get({ ...deps }, principal, params.id)",
      "async ({ deps, principal, params }) => { const d = deps; return understand.get(d, principal, params.id); }",
    ];
    for (const run of cases) {
      expect(checkRouteSource(FILE, handler(run))).toContain(
        "GET: uses deps other than handing it to its one service call — that is service work",
      );
    }
  });

  it("run that is not an arrow, or does not destructure plainly", () => {
    expect(checkRouteSource(FILE, handler("async function (args) { return understand.get(args.deps, args.principal, args.params.id); }"))).toContain(
      "GET: run must be an arrow function",
    );
    expect(checkRouteSource(FILE, handler("(args) => understand.get(args.deps, args.principal, args.params.id)"))).toContain(
      "GET: run destructures only { deps, principal, params, query, body }, by name",
    );
  });

  it("logic in a top-level helper function", () => {
    const source = `${handler("({ deps, principal, params }) => helper(deps, principal, params.id)")}
function helper(deps: never, principal: never, id: string) { return understand.get(deps, principal, id); }
`;
    expect(checkRouteSource(FILE, source)).toContain(
      "top-level FunctionDeclaration — a route file holds only imports, route() handlers and segment config",
    );
  });

  it("a handler not built with route({...})", () => {
    const source = `${header}
export const GET = async (req: Request) => Response.json(await understand.get(null as never, null as never, req.url));
`;
    expect(checkRouteSource(FILE, source)).toEqual([
      "GET is not built with route({...}) from @/server/http/handler — it would skip the IP tier",
    ]);
  });

  it("imports outside the allowlists: other modules, relative paths, non-plumbing names, side effects, require", () => {
    const source = `import { getDb } from "@/db/client";
import { enforceIpLimit } from "../../server/rate-limit/limiter";
import { toWire } from "@/server/http/wire";
import { route, handle } from "@/server/http/handler";
import "@/server/services/ask";
import * as understand from "@/server/services/understand";
import { IdParams } from "@/shared/contracts/common";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";
export const GET = route({ params: IdParams, response: DocumentWithFindingsOutput, run: ${one} });
export const dynamic = require("x");
`;
    expect(checkRouteSource(FILE, source)).toEqual([
      "uses require()",
      'imports "@/db/client" — route files import only services/data, contracts, views and ROUTE_PLUMBING',
      'imports "../../server/rate-limit/limiter" — route files import only services/data, contracts, views and ROUTE_PLUMBING',
      'imports "@/server/http/wire" — route files import only services/data, contracts, views and ROUTE_PLUMBING',
      'imports handle from "@/server/http/handler" — not route plumbing (see ROUTE_PLUMBING)',
      'side-effect import "@/server/services/ask"',
      "dynamic must be a literal",
    ]);
  });

  it("any runtime but the literal nodejs", () => {
    for (const value of ['"edge"', '"experimental-edge"', "`nodejs`", '"node" + "js"']) {
      expect(checkRouteSource(FILE, `${handler(one)}export const runtime = ${value};\n`)).toEqual([
        'runtime must be the literal "nodejs" — never the edge runtime (CLAUDE.md: no edge runtime for DB/LLM routes)',
      ]);
    }
    expect(checkRouteSource(FILE, `${handler(one)}export const runtime = "nodejs";\n`)).toEqual([]);
  });

  it("a type-only service import does not count as a call", () => {
    expect(checkRouteSource(FILE, `import type { UnderstandResult } from "@/server/services/understand";\n${handler(one)}`)).toEqual([]);
  });
});

describe("claim opt-ins are confined to POST /api/auth/claim", () => {
  const claimRoute = (flags: string) => `import { route } from "@/server/http/handler";
import * as claims from "@/server/services/claim";
import { ClaimResultOutput } from "@/shared/contracts/claim";
export const POST = route({
  ${flags}
  usesLlm: false,
  response: ClaimResultOutput,
  run: ({ deps, claim }) => claims.claimGuestSession(deps.db, claim),
});
`;

  it("passes the claim route's own shape at its own path (positive control)", () => {
    expect(checkRouteSource(CLAIM_ROUTE, claimRoute("claimSession: true, clearsGuestSession: true,"))).toEqual([]);
  });

  it("flags the same source anywhere else — every opt-in and the claim binding", () => {
    expect(checkRouteSource("src/app/api/documents/[id]/route.ts", claimRoute("claimSession: true, clearsGuestSession: true,"))).toEqual([
      "only src/app/api/auth/claim/route.ts may opt into claimSession / clearsGuestSession",
      "only src/app/api/auth/claim/route.ts may opt into claimSession / clearsGuestSession",
      "POST: only src/app/api/auth/claim/route.ts receives claim",
    ]);
  });

  it("flags a single opt-in, a quoted key, or a claim binding on its own", () => {
    const elsewhere = "src/app/api/projects/route.ts";
    expect(checkRouteSource(elsewhere, claimRoute('"clearsGuestSession": true,'))).toContain(
      "only src/app/api/auth/claim/route.ts may opt into claimSession / clearsGuestSession",
    );
    expect(checkRouteSource(elsewhere, claimRoute(""))).toEqual(["POST: only src/app/api/auth/claim/route.ts receives claim"]);
  });
});

describe("userSession opt-ins are confined to dev-sign-in (set) and sign-out (clear)", () => {
  const sessionRoute = (userSession: string) => `import { route } from "@/server/http/handler";
import * as session from "@/server/services/session";
import { SessionOutput } from "@/shared/contracts/session";
export const POST = route({
  userSession: ${userSession},
  usesLlm: false,
  response: SessionOutput,
  run: () => session.signOut(),
});
`;

  it("passes dev-sign-in's own shape at its own path (positive control)", () => {
    expect(checkRouteSource(USER_SESSION_SET_ROUTE, sessionRoute('"set"'))).toEqual([]);
  });

  it("passes sign-out's own shape at its own path (positive control)", () => {
    expect(checkRouteSource(USER_SESSION_CLEAR_ROUTE, sessionRoute('"clear"'))).toEqual([]);
  });

  it("flags the same source anywhere else", () => {
    expect(checkRouteSource("src/app/api/documents/[id]/route.ts", sessionRoute('"set"'))).toContain(
      `only ${USER_SESSION_SET_ROUTE} or ${USER_SESSION_CLEAR_ROUTE} may opt into userSession`,
    );
  });

  it.each(['"userSession"', '["userSession"]'])("flags a quoted or computed key (%s) naming userSession", (key) => {
    const source = `import { route } from "@/server/http/handler";
import * as session from "@/server/services/session";
import { SessionOutput } from "@/shared/contracts/session";
export const POST = route({ ${key}: "clear", usesLlm: false, response: SessionOutput, run: () => session.signOut() });
`;
    expect(checkRouteSource("src/app/api/projects/route.ts", source)).toContain(
      `only ${USER_SESSION_SET_ROUTE} or ${USER_SESSION_CLEAR_ROUTE} may opt into userSession`,
    );
  });
});

describe('principal: "none" is confined to GET /api/health', () => {
  const healthShape = (key: string) => `import { route } from "@/server/http/handler";
import { checkHealth } from "@/server/http/health";
import { HealthOutput } from "@/shared/contracts/health";
export const GET = route({ ${key}: "none", response: HealthOutput, run: async () => checkHealth() });
`;
  const VIOLATION = `only ${ANONYMOUS_ROUTE} may opt out of the principal (principal: "none")`;
  const elsewhere = "src/app/api/projects/route.ts";

  it("passes the health route's own shape at its own path (positive control)", () => {
    expect(ANONYMOUS_ROUTE).toBe("src/app/api/health/route.ts");
    expect(checkRouteSource(ANONYMOUS_ROUTE, healthShape("principal"))).toEqual([]);
  });

  it.each([["principal"], ['"principal"'], ['["principal"]']])("flags %s: \"none\" on any other route", (key) => {
    expect(checkRouteSource(elsewhere, healthShape(key))).toContain(VIOLATION);
  });

  it("flags the opt-out smuggled in through a spread", () => {
    const source = `import { route } from "@/server/http/handler";
import * as projects from "@/server/data/projects";
import { ProjectsListOutput } from "@/shared/contracts/projects";
export const GET = route({ ...{ principal: "none" }, usesLlm: false, response: ProjectsListOutput, run: ({ deps, principal }) => projects.listProjects(deps.db, principal) });
`;
    expect(checkRouteSource(elsewhere, source)).toContain(VIOLATION);
  });

  it("does not flag an object built inside run that names the principal (negative control)", () => {
    const run = "async ({ deps, principal, params }) => understand.get(deps, { principal }.principal, params.id)";
    expect(checkRouteSource(FILE, handler(run))).toEqual([]);
  });
});

describe("checkViewSource: a view is a pure mapper", () => {
  const VIEW = "src/server/http/views/example-view.ts";

  it("passes type-only service imports and value imports of contracts, core, verification and views", () => {
    const source = `import type { UnderstandResult } from "@/server/services/understand";
import type { Document } from "@/server/data/documents";
import { toVerificationOutput } from "../verification";
import { IdParams } from "@/shared/contracts/common";
import { notFound } from "@/server/core/errors";
import { documentView } from "./document-view";
export function exampleView(r: UnderstandResult, d: Document) { return { r, d, toVerificationOutput, IdParams, notFound, documentView }; }
`;
    expect(checkViewSource(VIEW, source)).toEqual([]);
  });

  it.each([
    ['import { get } from "@/server/services/understand";', '"@/server/services/understand"'],
    ['import { getDocument } from "../../data/documents";', '"../../data/documents"'],
    ['import { getContainer } from "@/server/container";', '"@/server/container"'],
    ['import { route } from "../handler";', '"../handler"'],
    ['import { getDb } from "@/db/client";', '"@/db/client"'],
    ['import { createGeminiClient } from "@/server/llm/providers";', '"@/server/llm/providers"'],
    ['export { get } from "@/server/services/understand";', '"@/server/services/understand"'],
    ['import "@/server/services/ask";', '"@/server/services/ask"'],
  ])("rejects %s", (statement, specifier) => {
    expect(checkViewSource(VIEW, `${statement}\n`)).toEqual([
      `imports ${specifier} by value — a view is a pure mapper (contracts, core, verification, views only)`,
    ]);
  });

  it("rejects a dynamic import or require", () => {
    expect(checkViewSource(VIEW, 'export const v = async () => (await import("@/server/services/ask")).ask;\n')).toEqual([
      "uses a dynamic import()",
    ]);
  });
});

describe("checkSpanTextWrites: spanText is only ever cut by toVerificationOutput", () => {
  const VIEW = "src/server/http/views/example-view.ts";

  it("flags a view that spreads a VerifyResult and adds its own spanText", () => {
    const source = `import type { VerifyResult } from "@/server/deterministic/verify";
export function forgedView(result: VerifyResult) { return { ...result, spanText: "ANY TEXT THE ROUTE LIKES" }; }
`;
    expect(checkSpanTextWrites(VIEW, source)).toEqual([
      "constructs a spanText key — only toVerificationOutput (src/server/http/verification.ts) may",
    ]);
  });

  it.each([
    ["shorthand", "const spanText = 'x'; export const v = { spanText };"],
    ["computed key", 'export const v = { ["spanText"]: "x" };'],
    ["assignment", "export function v(o: { spanText?: string }) { o.spanText = 'x'; }"],
    ["element assignment", 'export function v(o: Record<string, string>) { o["spanText"] = "x"; }'],
    ["defineProperty", 'export function v(o: object) { Object.defineProperty(o, "spanText", { value: "x" }); }'],
  ])("flags %s", (_label, source) => {
    expect(checkSpanTextWrites(VIEW, source)).not.toEqual([]);
  });

  it("allows reading spanText and naming it in a type", () => {
    const source = `import type { VerificationOutput } from "@/shared/contracts/common";
type Span = Pick<Extract<VerificationOutput, { status: "verified" }>, "spanText">;
export function read(v: Span) { return v.spanText.length; }
`;
    expect(checkSpanTextWrites(VIEW, source)).toEqual([]);
  });
});
