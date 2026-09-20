// Guest identity through the route layer: the signed, httpOnly guest_session cookie is minted,
// reused, rotated and — above all — is the ONLY thing a request can carry that identifies anyone.
// A user principal comes only from the container's auth hook.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as projectsRoute from "@/app/api/projects/route";
import {
  GUEST_SESSION_COOKIE_NAME,
  GUEST_SESSION_TTL_SECONDS,
  HOST_GUEST_SESSION_COOKIE_NAME,
} from "@/server/auth/session";
import {
  analyzedDocumentViaRoutes,
  callRoute,
  createRouteHarness,
  guestCookie,
  mintedCookie,
  request,
  sessionCookieOf,
  userA,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h.close();
});

function getDocument(id: string, options: { cookie?: string | null; headers?: Record<string, string>; query?: string }) {
  const path = `/api/documents/${id}${options.query ?? ""}`;
  return callRoute(documentRoute.GET, request("GET", path, options), { id });
}

const PRODUCTION_GUEST_SECRET = "production-guest-session-secret-0123456789";

function stubProduction(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GUEST_SESSION_SECRET", PRODUCTION_GUEST_SECRET);
  vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "production-ip-hash-secret-0123456789abcdef");
}

function listProjects(cookie?: string) {
  return callRoute(projectsRoute.GET, request("GET", "/api/projects", { cookie }));
}

// The signed value of a "name=value" Cookie header built by guestCookie().
const valueOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

describe("the guest session cookie", () => {
  it("is minted on a first request: httpOnly, SameSite=Lax, Path=/, the session TTL, not Secure outside production", async () => {
    const res = await listProjects();

    const cookie = mintedCookie(res);
    expect(cookie).toMatch(new RegExp(`^${GUEST_SESSION_COOKIE_NAME}=[0-9a-f-]{36}\\.\\d+\\.[A-Za-z0-9_-]+;`));
    const attributes = cookie?.split("; ").slice(1);
    expect(attributes).toEqual(["Path=/", `Max-Age=${GUEST_SESSION_TTL_SECONDS}`, "HttpOnly", "SameSite=Lax"]);
  });

  it("in production is __Host-guest_session: Secure, Path=/ and no Domain, as the prefix requires", async () => {
    stubProduction();

    const res = await listProjects();

    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie();
    expect(cookie).toHaveLength(1);
    expect(cookie[0]).toMatch(new RegExp(`^${HOST_GUEST_SESSION_COOKIE_NAME}=[0-9a-f-]{36}\\.\\d+\\.[A-Za-z0-9_-]+;`));
    expect(cookie[0].split("; ").slice(1)).toEqual([
      "Path=/",
      `Max-Age=${GUEST_SESSION_TTL_SECONDS}`,
      "HttpOnly",
      "SameSite=Lax",
      "Secure",
    ]);
  });

  it("in production only __Host-guest_session is read: a validly signed plain guest_session — what a sibling subdomain can plant — is no identity", async () => {
    vi.stubEnv("GUEST_SESSION_SECRET", PRODUCTION_GUEST_SECRET);
    const victim = guestCookie();
    const id = await analyzedDocumentViaRoutes(victim.cookie);
    const planted = guestCookie();
    stubProduction();

    const plain = await getDocument(id, { cookie: `${GUEST_SESSION_COOKIE_NAME}=${valueOf(victim.cookie)}` });
    const host = await getDocument(id, { cookie: `${HOST_GUEST_SESSION_COOKIE_NAME}=${valueOf(victim.cookie)}` });
    // The fixation attempt: the attacker's planted plain cookie ahead of the victim's own.
    const both = await getDocument(id, {
      cookie: `${GUEST_SESSION_COOKIE_NAME}=${valueOf(planted.cookie)}; ${HOST_GUEST_SESSION_COOKIE_NAME}=${valueOf(victim.cookie)}`,
    });

    expect(plain.status).toBe(404);
    expect(mintedCookie(plain)).toMatch(new RegExp(`^${HOST_GUEST_SESSION_COOKIE_NAME}=`));
    expect([host.status, mintedCookie(host)]).toEqual([200, null]);
    expect([both.status, mintedCookie(both)]).toEqual([200, null]);
  });

  it("outside production only guest_session is read (the mirror)", async () => {
    const owner = guestCookie();
    const id = await analyzedDocumentViaRoutes(owner.cookie);

    const host = await getDocument(id, { cookie: `${HOST_GUEST_SESSION_COOKIE_NAME}=${valueOf(owner.cookie)}` });
    const plain = await getDocument(id, { cookie: `${GUEST_SESSION_COOKIE_NAME}=${valueOf(owner.cookie)}` });

    expect(host.status).toBe(404);
    expect(mintedCookie(host)).toMatch(new RegExp(`^${GUEST_SESSION_COOKIE_NAME}=`));
    expect([plain.status, mintedCookie(plain)]).toEqual([200, null]);
  });

  it("is minted even on an error response, and then identifies the same guest", async () => {
    const notFound = await getDocument("not-a-uuid", {});
    expect(notFound.status).toBe(404);
    const cookie = sessionCookieOf(notFound);

    const id = await analyzedDocumentViaRoutes(cookie);
    const again = await getDocument(id, { cookie });

    expect(again.status).toBe(200);
    expect(mintedCookie(again)).toBeNull();
  });

  it("a tampered cookie is no identity: a new session is minted and the old session's document is 404", async () => {
    const { cookie } = guestCookie();
    const id = await analyzedDocumentViaRoutes(cookie);
    const tampered = `${cookie.slice(0, -2)}${cookie.endsWith("AA") ? "BB" : "AA"}`;

    const res = await getDocument(id, { cookie: tampered });

    expect(res.status).toBe(404);
    expect(mintedCookie(res)).not.toBeNull();
  });

  it("rotation: a cookie signed with GUEST_SESSION_SECRET_PREVIOUS is still the same guest", async () => {
    vi.stubEnv("GUEST_SESSION_SECRET", "a".repeat(40));
    const { cookie } = guestCookie();
    const id = await analyzedDocumentViaRoutes(cookie);

    vi.stubEnv("GUEST_SESSION_SECRET", "b".repeat(40));
    vi.stubEnv("GUEST_SESSION_SECRET_PREVIOUS", "a".repeat(40));
    const rotated = await getDocument(id, { cookie });
    expect(rotated.status).toBe(200);
    expect(mintedCookie(rotated)).toBeNull();

    // Control: once the previous secret is dropped, the old cookie no longer verifies.
    vi.stubEnv("GUEST_SESSION_SECRET_PREVIOUS", "");
    const expired = await getDocument(id, { cookie });
    expect(expired.status).toBe(404);
    expect(mintedCookie(expired)).not.toBeNull();
  });
});

describe("nothing a request carries makes it a user", () => {
  it("a request claiming user A through headers, query, bearer token and unsigned cookies is a fresh guest", async () => {
    h.signIn(userA);
    const id = await analyzedDocumentViaRoutes(null);
    h.signIn(null);

    const res = await getDocument(id, {
      query: `?userId=${userA.userId}&principal=user:${userA.userId}`,
      headers: {
        "x-user-id": userA.userId,
        "x-principal": JSON.stringify(userA),
        "x-guest-session-id": userA.userId,
        "x-forwarded-user": userA.userId,
        authorization: `Bearer ${userA.userId}`,
        cookie: `user_id=${userA.userId}; principal=user:${userA.userId}; sb-access-token=${userA.userId}; ${GUEST_SESSION_COOKIE_NAME}=${userA.userId}`,
      },
    });

    expect(res.status).toBe(404);
    // A new guest session: the request had no identity the server accepts.
    expect(mintedCookie(res)).not.toBeNull();

    // Positive control: the same document IS reachable as user A — through the auth hook only.
    h.signIn(userA);
    expect((await getDocument(id, {})).status).toBe(200);
  });

  it("a guest's own session id in a header does not make another request that guest", async () => {
    const owner = guestCookie();
    const id = await analyzedDocumentViaRoutes(owner.cookie);

    const res = await getDocument(id, {
      headers: { "x-guest-session-id": owner.guestSessionId, cookie: `guest_session_id=${owner.guestSessionId}` },
    });

    expect(res.status).toBe(404);
    expect((await getDocument(id, { cookie: owner.cookie })).status).toBe(200);
  });
});
