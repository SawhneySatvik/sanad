/**
 * The wrapper every route handler under src/app/api is built with: validates params/query/body,
 * resolves the principal, builds request-scoped deps, and maps the result through its wire
 * contract (JSON, or an SSE stream whose first event decides the HTTP status). A cross-site
 * state-changing request is refused before any cookie or identity is touched; a params validation
 * failure is always 404, byte-identical to a missing or foreign id. The principal rate-limit tier
 * is charged only inside `deps.llm`, per LLM call — never here, never twice. Every response,
 * refusals and errors included, carries securityHeaders().
 */

import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { getContainer, type ServiceDeps } from "@/server/container";
import { AppError, notFound, safeMessageFor, type AppErrorCode } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { clientIpFromHeaders, UNKNOWN_CLIENT_IP } from "@/server/rate-limit/client-ip";
import { enforceIpLimit } from "@/server/rate-limit/limiter";
import { crossSiteRefusal, errorResponse, logRequestError, mapError, type RequestLogContext } from "./errors";
import { clearedGuestSessionCookie, type ClaimSession } from "./claim-session";
import { clearedUserSessionCookie, guestFromCookie, mintedUserSessionCookie, resolveRequestPrincipal } from "./principal";
import { securityHeaders } from "./security-headers";
import { eventStreamResponse } from "./sse";
import { toWire } from "./wire";

/** Route params as Next.js (15+) passes them: a promise, not a plain object. */
export interface RouteContext {
  params: Promise<Record<string, string | string[] | undefined>>;
}

/** The Next.js route-handler signature route() returns. */
export type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response>;

type BodySpec = z.ZodType | "file";
type Parsed<S> = S extends "file" ? Uint8Array : S extends z.ZodType ? z.output<S> : undefined;

/** Arguments a JSON route's `run` receives: request-scoped deps, the resolved principal, and parsed params/query/body. */
export interface RunArgs<P, Q, B> {
  deps: ServiceDeps;
  principal: Principal;
  params: Parsed<P>;
  query: Parsed<Q>;
  body: Parsed<B>;
}

/** Run arguments for event-stream routes; `signal` aborts in-flight LLM calls when the client disconnects. */
export interface StreamRunArgs<P, Q, B> extends RunArgs<P, Q, B> {
  signal: AbortSignal;
}

interface RouteSpecBase<P, Q, B> {
  params?: P;
  query?: Q;
  body?: B;
  maxBodyBytes?: number;
  // Default true; false only when the route's service never reads deps.llm.
  usesLlm?: boolean;
  // A guest is refused (400 VALIDATION_FAILED) before params, query or body are read, so a guest
  // can't make a user-only route buffer its large body cap.
  requireUser?: boolean;
  principal?: never;
}

/**
 * A route answering one JSON body. `claimSession`/`clearsGuestSession` are typed `never` so a
 * claim route can't accidentally match this overload.
 *
 * `userSession: "set"` signs a fresh dev user-session cookie from `run()`'s result (which must then
 * carry a `userId: string` alongside its declared response shape — `toWire` strips it before the
 * client sees it); `"clear"` drops that cookie. Either way the cookie is appended only once `run()`
 * and the response contract have both succeeded — the same guarantee `clearsGuestSession` gets, and
 * independent of it: a route may mint a fresh guest cookie (via principal resolution) and set/clear
 * the user cookie in the very same response.
 */
export interface JsonRouteSpec<P, Q, B> extends RouteSpecBase<P, Q, B> {
  response: z.ZodType;
  run(args: RunArgs<P, Q, B>): Promise<unknown>;
  claimSession?: never;
  clearsGuestSession?: boolean;
  userSession?: "set" | "clear";
}

export interface NoContentRouteSpec<P, Q, B> extends RouteSpecBase<P, Q, B> {
  status: 204;
  response?: never;
  run(args: RunArgs<P, Q, B>): Promise<unknown>;
  claimSession?: never;
  clearsGuestSession?: never;
  userSession?: never;
}

/** A route answering a server-sent-event stream instead of one JSON body. */
export interface EventStreamRouteSpec<P, Q, B> extends RouteSpecBase<P, Q, B> {
  events: z.ZodType;
  run(args: StreamRunArgs<P, Q, B>): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  claimSession?: never;
  clearsGuestSession?: never;
  userSession?: never;
}

/** Adds the resolved claim identities to a JSON route's run arguments. */
export interface ClaimRunArgs<P, Q, B> extends RunArgs<P, Q, B> {
  claim: ClaimSession;
}

/**
 * POST /api/auth/claim's own route shape: `run` additionally receives the resolved claim. JSON
 * only — a stream's 200 commits before its outcome is known.
 */
export interface ClaimRouteSpec<P, Q, B> extends RouteSpecBase<P, Q, B> {
  claimSession: true;
  clearsGuestSession?: boolean;
  userSession?: never;
  response: z.ZodType;
  run(args: ClaimRunArgs<P, Q, B>): Promise<unknown>;
}

/**
 * GET /api/health's own shape: no caller identity at all — no IP-tier charge, no auth hook, no
 * guest session minted — and so no deps, params, query or body. The route-conventions gate keeps
 * every other route off it.
 */
export interface AnonymousRouteSpec {
  principal: "none";
  response: z.ZodType;
  run(): Promise<unknown>;
}

type IdentifiedRouteSpec =
  | JsonRouteSpec<z.ZodType | undefined, z.ZodType | undefined, BodySpec | undefined>
  | NoContentRouteSpec<z.ZodType | undefined, z.ZodType | undefined, BodySpec | undefined>
  | EventStreamRouteSpec<z.ZodType | undefined, z.ZodType | undefined, BodySpec | undefined>
  | ClaimRouteSpec<z.ZodType | undefined, z.ZodType | undefined, BodySpec | undefined>;
type AnyRouteSpec = IdentifiedRouteSpec | AnonymousRouteSpec;

/** Default request body cap; a route overrides it via `maxBodyBytes`. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Sec-Fetch-Site is set by the browser; a page can't forge it. `same-site` is refused as well: the
// app is one origin with no CORS, so no legitimate browser caller is ever same-site, while a page
// on a sibling subdomain — whose requests still carry SameSite=Lax cookies — always is. A browser
// too old to send Sec-Fetch-Site still sends Origin on a POST; a request with neither is not from
// a browser page, so there is no ambient cookie to ride on.
function isCrossSiteStateChange(req: Request): boolean {
  if (!STATE_CHANGING_METHODS.has(req.method.toUpperCase())) return false;
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "same-origin" || site === "none") return false;
  if (site === "cross-site" || site === "same-site") return true;
  const origin = req.headers.get("origin");
  return origin !== null && !isOwnHost(req, origin);
}

// The same rule Next.js applies to Server Actions: the Origin's host must be the host the browser
// addressed — X-Forwarded-Host's first entry behind a proxy, or Host. Never req.url: `next start`
// builds that from its own listen address, not from what the browser asked for. The scheme isn't
// compared, as in Next; HSTS keeps browsers off plain http. "null" and garbage never match.
function isOwnHost(req: Request, origin: string): boolean {
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0].trim();
  return originHost !== "" && (originHost === forwardedHost || originHost === req.headers.get("host"));
}

/**
 * Wraps a route spec into a Next.js route handler: validates the request, resolves the principal,
 * builds deps, runs the handler, and maps the result through its wire contract.
 *
 * @example
 * export const GET = route({
 *   params: IdParams,
 *   response: DocumentOutput,
 *   run: async ({ deps, principal, params }) => documentView(await understand.get(deps, principal, params.id)),
 * });
 */
export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends BodySpec | undefined = undefined,
>(spec: JsonRouteSpec<P, Q, B>): RouteHandler;
export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends BodySpec | undefined = undefined,
>(spec: NoContentRouteSpec<P, Q, B>): RouteHandler;
// A separate overload: in a union with JsonRouteSpec's, TS infers `any` for an untyped `run` callback.
export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends BodySpec | undefined = undefined,
>(spec: EventStreamRouteSpec<P, Q, B>): RouteHandler;
// The claim route's own overload, so every other route's typing is unaffected.
export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends BodySpec | undefined = undefined,
>(spec: ClaimRouteSpec<P, Q, B>): RouteHandler;
// GET /api/health's overload: a run that takes nothing, since nothing about the caller is resolved.
export function route(spec: AnonymousRouteSpec): RouteHandler;
export function route(spec: AnyRouteSpec): RouteHandler {
  return (req, ctx) => handle(req, ctx, spec);
}

async function handle(req: Request, ctx: RouteContext, spec: AnyRouteSpec): Promise<Response> {
  const url = new URL(req.url);
  const log: RequestLogContext = { correlationId: randomUUID(), method: req.method, path: url.pathname };
  let setCookie: string | null = null;
  let clearGuestSession = false;
  let userSessionCookie: string | null = null;
  let response: Response;
  try {
    if (isCrossSiteStateChange(req)) {
      // Refused before any cookie is read or minted: otherwise a cross-site form POST (cookie-less
      // under SameSite=Lax) gets a fresh guest cookie that the browser stores over the victim's, orphaning their rows.
      response = crossSiteRefusal(log);
    } else if (spec.principal === "none") {
      response = jsonResponse(spec.response, await spec.run());
    } else {
      const container = getContainer();
      const ip = clientIpFromHeaders(req.headers);
      await enforceIpLimit(container.db, ip.ok ? ip.value : UNKNOWN_CLIENT_IP, {
        limit: container.rateLimits.ipPerMinute,
        clock: container.rateLimits.clock,
      });

      const resolved = await resolveRequestPrincipal(req, container.authenticateUser);
      setCookie = resolved.setCookie;
      if (spec.requireUser === true && resolved.principal.type !== "user") throw invalidRequest();

      // params failing is 404, byte-identical to a missing/foreign id; query/body failing is 400.
      const params = spec.params ? parseOr(spec.params, await ctx.params, notFound) : undefined;
      const query = spec.query ? parseOr(spec.query, Object.fromEntries(url.searchParams), invalidRequest) : undefined;
      const body = await readBody(req, spec);
      const deps = container.forRequest(resolved.principal, spec.usesLlm ?? true, ip.ok ? ip.value : UNKNOWN_CLIENT_IP);
      const args = { deps, principal: resolved.principal, params, query, body };

      if ("events" in spec) {
        response = await eventStreamResponse(await spec.run({ ...args, signal: req.signal }), spec.events, log);
      } else if (spec.claimSession === true) {
        // claim.user is the same authenticateUser answer that resolved `principal`, never asked
        // twice; claim.guest is read from the request's own signed cookie, independently.
        const claim: ClaimSession = {
          user: resolved.principal.type === "user" ? resolved.principal : null,
          guest: guestFromCookie(req),
        };
        response = jsonResponse(spec.response, await spec.run({ ...args, claim }));
        // Reached only once run and the response contract both succeeded.
        clearGuestSession = spec.clearsGuestSession === true;
      } else {
        const result = await spec.run(args);
        response = "status" in spec && spec.status === 204 ? new Response(null, { status: 204 }) : jsonResponse(spec.response!, result);
        if ("clearsGuestSession" in spec && spec.clearsGuestSession === true) clearGuestSession = true;
        // Reached only once run and the response contract both succeeded — same guarantee as
        // clearGuestSession above, and independent of it: see JsonRouteSpec's userSession doc.
        if (spec.userSession === "set") userSessionCookie = mintedUserSessionCookie(userIdFromResult(result));
        else if (spec.userSession === "clear") userSessionCookie = clearedUserSessionCookie();
      }
    }
  } catch (error) {
    const mapped = mapError(error);
    logRequestError(log, mapped.status, error);
    response = errorResponse(mapped, log.correlationId);
  }
  for (const [name, value] of Object.entries(securityHeaders())) response.headers.set(name, value);
  if (clearGuestSession) response.headers.append("set-cookie", clearedGuestSessionCookie());
  else if (setCookie) response.headers.append("set-cookie", setCookie);
  // Independent of the guest cookie above: a first-time sign-in may mint both in one response.
  if (userSessionCookie) response.headers.append("set-cookie", userSessionCookie);
  return response;
}

// userSession: "set" routes' run() returns their declared response shape plus this one extra field —
// toWire strips it before the client ever sees it (wire.ts). A route wired up wrong (no userId) fails
// loudly here rather than silently omitting the Set-Cookie a signed-in caller needs.
function userIdFromResult(result: unknown): string {
  const userId = (result as { userId?: unknown } | null)?.userId;
  if (typeof userId !== "string" || userId === "") {
    throw new Error('a userSession: "set" route\'s run() must return a userId');
  }
  return userId;
}

function jsonResponse(contract: z.ZodType, result: unknown): Response {
  return Response.json(toWire(contract, result), { headers: { "cache-control": "no-store" } });
}

function invalidRequest(): AppError {
  return new AppError("VALIDATION_FAILED", safeMessageFor("VALIDATION_FAILED"));
}

// safeParse, never parse: a ZodError's message echoes the input it rejected.
function parseOr<S extends z.ZodType>(schema: S, value: unknown, fail: () => AppError): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw fail();
  return result.data;
}

async function readBody(req: Request, spec: IdentifiedRouteSpec): Promise<unknown> {
  if (spec.body === undefined) return undefined;
  const maxBytes = spec.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (spec.body === "file") return readBodyBytes(req, maxBytes, "INVALID_DOCUMENT");

  const mediaType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw invalidRequest();
  const bytes = await readBodyBytes(req, maxBytes, "VALIDATION_FAILED");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidRequest();
  }
  return parseOr(spec.body, json, invalidRequest);
}

// Rejects a declared Content-Length over the cap without reading anything, then counts bytes as
// they stream in — a missing or understated Content-Length cannot make it buffer past the cap.
async function readBodyBytes(req: Request, maxBytes: number, tooLarge: AppErrorCode): Promise<Uint8Array> {
  // reason is only meaningful on INVALID_DOCUMENT (the file-body relay cap) — the VALIDATION_FAILED
  // case (an oversized JSON body) has no reason enum entry and must stay bare.
  const tooLargeError = () => new AppError(tooLarge, safeMessageFor(tooLarge), tooLarge === "INVALID_DOCUMENT" ? { reason: "too_large" } : undefined);
  if (Number(req.headers.get("content-length")) > maxBytes) throw tooLargeError();
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, total);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLargeError();
    }
    chunks.push(value);
  }
}
