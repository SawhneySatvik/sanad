// Route-test harness, shared by every route test file. Every route test runs the exported route
// handler with a real Request through the SAME wiring production uses, over in-memory PGlite, a
// temp-directory LocalFsStorageAdapter and FakeLlmClients — nothing else is faked.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import * as documentsRoute from "@/app/api/documents/route";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { createGuestSession, guestSessionCookieName } from "@/server/auth/session";
import {
  createContainer,
  setContainerForTests,
  type Container,
  type LlmProviders,
  type RateLimitOverrides,
} from "@/server/container";
import { AppError } from "@/server/core/errors";
import { canAccess } from "@/server/data/access";
import type { RouteHandler } from "@/server/http/handler";
import type { UserPrincipal } from "@/server/http/principal";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { leaseOutput } from "@tests/support/services/understand";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import type { AnalyzeDocumentInput } from "@/shared/contracts/documents";

export const TEST_MODEL_ID = "fake-model";
// The storage adapter's signing secret, and the one the relay tokens are derived from — as in
// production, where both come from LOCAL_STORAGE_SIGNING_SECRET.
export const SIGNING_SECRET = "route-test-signing-secret-0123456789abcdef";
export const FIXTURES_DIR = path.join(process.cwd(), "tests", "fixtures", "documents");
export const LEASE_FIXTURE = "leave_and_license.txt";

export const userA: UserPrincipal = { type: "user", userId: "a1a1a1a1-0000-4000-8000-0000000000a1" };
export const userB: UserPrincipal = { type: "user", userId: "b2b2b2b2-0000-4000-8000-0000000000b2" };

// A fixed instant for rate-limit tests: every request lands in the same fixed-minute window, so a
// slow run can never cross a window boundary mid-test and reset a bucket.
export const FIXED_CLOCK = { now: () => new Date("2026-09-23T10:00:30.000Z") };

// High enough that no test trips a limit by accident; a rate-limit test passes its own.
const GENEROUS_LIMITS: RateLimitOverrides = {
  ipPerMinute: 1000,
  principalPerMinute: 1000,
  ipLlmPerMinute: 1000,
  principalPerDay: 1000,
  ipLlmPerDay: 1000,
  primaryPerMinute: 1000,
  secondaryPerMinute: 1000,
};

export interface RouteHarnessOptions {
  // Default: answers every call with the lease fixture's analysis.
  primary?: FakeLlmClient;
  // Default: unavailable, so a failing primary surfaces as a typed 503, not a fake's own crash.
  secondary?: FakeLlmClient;
  // Replaces the container's provider thunk — e.g. one that throws a ConfigError, as a missing key does.
  providers?: () => LlmProviders;
  rateLimits?: RateLimitOverrides;
}

export interface RouteHarness {
  t: TestDb;
  storage: LocalFsStorageAdapter;
  primary: FakeLlmClient;
  secondary: FakeLlmClient;
  container: Container;
  // Identity works exactly as in production: a user exists only because the test told the
  // container's auth hook to answer with one — never through anything a request carries. What the
  // hook answers from now on (null: nobody is signed in).
  signIn(user: UserPrincipal | null): void;
  // How many times the container's auth hook has run.
  authCalls(): number;
  close(): Promise<void>;
}

export function unavailable(): FakeLlmClient {
  return new FakeLlmClient({
    modelUsed: "fake-secondary",
    defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "fake provider unavailable") },
  });
}

export async function createRouteHarness(options: RouteHarnessOptions = {}): Promise<RouteHarness> {
  const t = await createTestDb();
  await t.db.insert(schema.users).values([
    { id: userA.userId, email: "a@example.com" },
    { id: userB.userId, email: "b@example.com" },
  ]);
  const rootDir = await mkdtemp(path.join(tmpdir(), "route-test-"));
  const storage = new LocalFsStorageAdapter({
    rootDir,
    signingSecret: SIGNING_SECRET,
    accessCheck: canAccess,
  });
  const primary =
    options.primary ?? new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: leaseOutput() } });
  const secondary = options.secondary ?? unavailable();
  let currentUser: UserPrincipal | null = null;
  let authCalls = 0;
  const container = createContainer({
    db: t.db,
    storage: () => storage,
    llm: options.providers ?? (() => ({ primary, secondary })),
    localStorageSigningSecret: () => SIGNING_SECRET,
    primaryModelId: TEST_MODEL_ID,
    authenticateUser: async () => {
      authCalls++;
      return currentUser;
    },
    rateLimits: { ...GENEROUS_LIMITS, ...options.rateLimits },
  });
  setContainerForTests(container);

  return {
    t,
    storage,
    primary,
    secondary,
    container,
    signIn: (user) => {
      currentUser = user;
    },
    authCalls: () => authCalls,
    close: async () => {
      setContainerForTests(undefined);
      await t.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

// A fresh guest identity, signed with the real session signer: the Cookie header value to send,
// under the current mode's cookie name (__Host-guest_session when NODE_ENV is production).
export function guestCookie(): { cookie: string; guestSessionId: string } {
  const session = createGuestSession();
  return { cookie: `${guestSessionCookieName()}=${session.cookieValue}`, guestSessionId: session.guestSessionId };
}

export interface RequestOptions {
  cookie?: string | null;
  headers?: Record<string, string>;
  json?: unknown;
  bytes?: Uint8Array;
}

export function request(method: string, pathAndQuery: string, options: RequestOptions = {}): Request {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  // Copied into a fresh ArrayBuffer-backed view, which is what BodyInit accepts.
  if (options.bytes !== undefined) body = new Uint8Array(options.bytes);
  return new Request(new URL(pathAndQuery, "http://localhost"), { method, headers, body });
}

export function callRoute(handler: RouteHandler, req: Request, params: Record<string, string> = {}): Promise<Response> {
  return handler(req, { params: Promise.resolve(params) });
}

// The guest-session Set-Cookie (current mode's name) a response carries, or null if it minted none.
export function mintedCookie(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${guestSessionCookieName()}=`)) ?? null;
}

// "guest_session=<value>" from a response that minted a session — the next request's Cookie header.
export function sessionCookieOf(res: Response): string {
  const cookie = mintedCookie(res);
  if (!cookie) throw new Error("response minted no guest session");
  return cookie.split(";")[0];
}

export async function readFixture(fixture: string): Promise<Buffer> {
  return readFile(path.join(FIXTURES_DIR, fixture));
}

// POST /api/uploads → PUT the bytes to its uploadUrl — the real client flow. Returns the body for
// POST /api/documents.
export async function uploadViaRoutes(
  cookie: string | null,
  fixture = LEASE_FIXTURE,
  mimeType = "text/plain",
): Promise<AnalyzeDocumentInput> {
  const bytes = await readFixture(fixture);
  const targetRes = await callRoute(
    uploadsRoute.POST,
    request("POST", "/api/uploads", { cookie, json: { filename: fixture, mimeType, sizeBytes: bytes.byteLength } }),
  );
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as { uploadUrl: string; ref: string };
  const relayRes = await callRoute(uploadsRelayRoute.PUT, request("PUT", target.uploadUrl, { cookie, bytes }));
  expect(relayRes.status).toBe(200);
  return { storageRef: target.ref, filename: fixture, mimeType };
}

// Upload + POST /api/documents; returns the analysed document's id.
export async function analyzedDocumentViaRoutes(cookie: string | null, fixture = LEASE_FIXTURE): Promise<string> {
  const input = await uploadViaRoutes(cookie, fixture);
  const res = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { document: { id: string } }).document.id;
}
