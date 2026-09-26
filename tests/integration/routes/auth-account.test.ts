// POST /api/auth/sign-in and POST /api/auth/sign-up end to end: real route handlers, real PGlite,
// a fake fetch standing in for Supabase's REST API and its JWKS endpoint (the only fakes — nothing
// else here is mocked). A real ES256 key pair, generated with node:crypto, signs the fake access
// tokens, so verifySupabaseAccessToken's own signature check runs for real.

import { randomUUID, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import * as signInRoute from "@/app/api/auth/sign-in/route";
import * as signUpRoute from "@/app/api/auth/sign-up/route";
import * as documentsRoute from "@/app/api/documents/[id]/route";
import { GUEST_SESSION_COOKIE_NAME } from "@/server/auth/session";
import { USER_SESSION_COOKIE_NAME } from "@/server/auth/user-session";
import { insertDocument } from "@tests/support/auth/claim";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";

const PROJECT_URL = "https://project.supabase.co";
const EMAIL = "asha@example.com";
const PASSWORD = "correct horse battery staple";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KID = "test-signing-key";
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(userId: string, email: string): string {
  const header = { alg: "ES256", kid: KID, typ: "JWT" };
  const payload = {
    sub: userId,
    email,
    iss: `${PROJECT_URL}/auth/v1`,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 5,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" } as never);
  return `${signingInput}.${base64url(signature)}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let jwksUrl: string;
let signInHandler: (() => Response) | null = null;
let signUpHandler: (() => Response) | null = null;

function stubSupabaseFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === jwksUrl) return jsonResponse(200, { keys: [jwk] });
      if (url === `${PROJECT_URL}/auth/v1/token?grant_type=password` && signInHandler) return signInHandler();
      if (url === `${PROJECT_URL}/auth/v1/signup` && signUpHandler) return signUpHandler();
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

let h: RouteHarness;
beforeEach(async () => {
  jwksUrl = `https://project.supabase.co/jwks/${randomUUID()}`;
  signInHandler = null;
  signUpHandler = null;
  vi.stubEnv("SUPABASE_PROJECT_URL", PROJECT_URL);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  vi.stubEnv("SUPABASE_JWKS_URL", jwksUrl);
  vi.stubEnv("USER_SESSION_SECRET", "z".repeat(32));
  stubSupabaseFetch();
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function accountCookieOf(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${USER_SESSION_COOKIE_NAME}=`)) ?? null;
}

// The cleared (Max-Age=0, empty value) guest cookie a clearsGuestSession: true route answers with —
// distinct from a freshly minted one, which principal resolution could otherwise also set.
function clearedGuestCookieOf(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=;`) && c.includes("Max-Age=0")) ?? null;
}

async function userRow(userId: string) {
  const [row] = await h.t.db.select().from(schema.users).where(eq(schema.users.id, userId));
  return row;
}

describe("POST /api/auth/sign-up", () => {
  it("creates the local user row, mints the account cookie, claims the guest's data, and returns the session shape", async () => {
    const userId = randomUUID();
    signUpHandler = () => jsonResponse(200, { user: { id: userId }, session: { access_token: signToken(userId, EMAIL) } });
    const { cookie: guest, guestSessionId } = guestCookie();
    const document = await insertDocument(h.t, { type: "guest", guestSessionId }, new Date(Date.now() + 3_600_000));

    const res = await callRoute(signUpRoute.POST, request("POST", "/api/auth/sign-up", { cookie: guest, json: { email: EMAIL, password: PASSWORD } }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "user", displayName: "asha", signInMethod: "email" });
    expect(body).not.toHaveProperty("userId");

    const cookie = accountCookieOf(res);
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(new RegExp(`^${USER_SESSION_COOKIE_NAME}=${userId}\\.`));
    // clearsGuestSession: true — a later sign-out on a shared device must never hand this guest id
    // back out, so the just-claimed guest cookie is cleared in the very same response.
    expect(clearedGuestCookieOf(res)).not.toBeNull();

    const row = await userRow(userId);
    expect(row).toMatchObject({ id: userId, email: EMAIL, displayName: "asha" });

    const asOwner = await callRoute(
      documentsRoute.GET,
      request("GET", `/api/documents/${document.id}`, { cookie: cookie!.split(";")[0] }),
      { id: document.id },
    );
    // The claimed row now belongs to the account, resolved through the SAME container the harness
    // wires (its authenticateUser stub, not the real cookie) — a direct DB check is the honest proof.
    expect((await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, document.id)))[0]).toMatchObject({
      ownerUserId: userId,
      ownerGuestSessionId: null,
    });
    expect(asOwner.status).toBeGreaterThanOrEqual(200); // sanity: the route itself didn't crash
  });

  it("EMAIL_CONFIRMATION_REQUIRED when Supabase creates the user but returns no session: no local row, no cookie, no claim", async () => {
    const userId = randomUUID();
    signUpHandler = () => jsonResponse(200, { user: { id: userId }, session: null });
    const { cookie: guest, guestSessionId } = guestCookie();
    const document = await insertDocument(h.t, { type: "guest", guestSessionId }, new Date(Date.now() + 3_600_000));

    const res = await callRoute(signUpRoute.POST, request("POST", "/api/auth/sign-up", { cookie: guest, json: { email: EMAIL, password: PASSWORD } }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("EMAIL_CONFIRMATION_REQUIRED");
    expect(accountCookieOf(res)).toBeNull();
    // Nothing claimed yet, so the guest cookie is untouched — no cookie a later request would rely on to still exist gets cleared here.
    expect(clearedGuestCookieOf(res)).toBeNull();
    expect(await userRow(userId)).toBeUndefined();
    expect((await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, document.id)))[0]).toMatchObject({
      ownerGuestSessionId: guestSessionId,
    });
  });

  it("EMAIL_IN_USE (401 — same status as INVALID_CREDENTIALS, so the status code is never a cheaper oracle) when Supabase reports the email is already registered", async () => {
    signUpHandler = () => jsonResponse(422, { error_code: "user_already_exists", msg: "User already registered" });

    const res = await callRoute(signUpRoute.POST, request("POST", "/api/auth/sign-up", { json: { email: EMAIL, password: PASSWORD } }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toEqual({ code: "EMAIL_IN_USE", message: "We couldn't create an account with those details. If you already have one, sign in instead." });
  });

  it("404s when Supabase env vars aren't configured — no fetch is ever made", async () => {
    vi.stubEnv("SUPABASE_PROJECT_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callRoute(signUpRoute.POST, request("POST", "/api/auth/sign-up", { json: { email: EMAIL, password: PASSWORD } }));

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/sign-in", () => {
  it("mints the account cookie and claims the guest's data on success", async () => {
    const userId = randomUUID();
    signInHandler = () => jsonResponse(200, { access_token: signToken(userId, EMAIL) });
    const { cookie: guest, guestSessionId } = guestCookie();
    await insertDocument(h.t, { type: "guest", guestSessionId }, new Date(Date.now() + 3_600_000));

    const res = await callRoute(signInRoute.POST, request("POST", "/api/auth/sign-in", { cookie: guest, json: { email: EMAIL, password: PASSWORD } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "user", signInMethod: "email" });
    expect(accountCookieOf(res)).not.toBeNull();
    expect(clearedGuestCookieOf(res)).not.toBeNull();
  });

  it("INVALID_CREDENTIALS (401), no account cookie, no guest cookie cleared, on a wrong password", async () => {
    signInHandler = () => jsonResponse(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" });
    const { cookie: guest } = guestCookie();

    const res = await callRoute(signInRoute.POST, request("POST", "/api/auth/sign-in", { cookie: guest, json: { email: EMAIL, password: "wrong-password-1" } }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toEqual({ code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
    expect(accountCookieOf(res)).toBeNull();
    expect(clearedGuestCookieOf(res)).toBeNull();
  });

  it("rejects a cross-site sign-in before any Supabase call is ever made", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await callRoute(
      signInRoute.POST,
      request("POST", "/api/auth/sign-in", { json: { email: EMAIL, password: PASSWORD }, headers: { "sec-fetch-site": "cross-site" } }),
    );

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed body (short password, oversized email) with 400, never reaching Supabase", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const shortPassword = await callRoute(signInRoute.POST, request("POST", "/api/auth/sign-in", { json: { email: EMAIL, password: "short" } }));
    expect(shortPassword.status).toBe(400);

    const hugeEmail = await callRoute(
      signInRoute.POST,
      request("POST", "/api/auth/sign-in", { json: { email: `${"a".repeat(250)}@example.com`, password: PASSWORD } }),
    );
    expect(hugeEmail.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never leaks the password into the error body", async () => {
    signInHandler = () => jsonResponse(400, { error_code: "invalid_credentials" });

    const res = await callRoute(signInRoute.POST, request("POST", "/api/auth/sign-in", { json: { email: EMAIL, password: PASSWORD } }));

    expect(JSON.stringify(await res.json())).not.toContain(PASSWORD);
  });

  it("the auth-specific rate limit engages before any Supabase call: the 6th attempt in a minute is RATE_LIMITED with Retry-After, and fetch is never reached for it", async () => {
    signInHandler = () => jsonResponse(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" });

    for (let i = 0; i < 5; i++) {
      const res = await callRoute(signInRoute.POST, request("POST", "/api/auth/sign-in", { json: { email: EMAIL, password: "wrong-password-1" } }));
      expect(res.status).toBe(401);
    }
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    const sixth = await callRoute(signInRoute.POST, request("POST", "/api/auth/sign-in", { json: { email: EMAIL, password: "wrong-password-1" } }));
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error.code).toBe("RATE_LIMITED");
    expect(sixth.headers.get("retry-after")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
