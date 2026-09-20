// GET /api/session, POST /api/auth/dev-sign-in and POST /api/session/sign-out (docs/API.md). Drives
// the real route handlers end to end over PGlite: route()'s userSession opt-in -> services/session.ts
// -> auth/dev-session.ts's signed cookie.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as claimRoute from "@/app/api/auth/claim/route";
import * as devSignInRoute from "@/app/api/auth/dev-sign-in/route";
import * as documentsRoute from "@/app/api/documents/[id]/route";
import * as sessionRoute from "@/app/api/session/route";
import * as signOutRoute from "@/app/api/session/sign-out/route";
import { DEV_USER_SESSION_COOKIE_NAME, deriveDevUserId } from "@/server/auth/dev-session";
import { GUEST_SESSION_COOKIE_NAME } from "@/server/auth/session";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";
import { insertDocument } from "@tests/support/auth/claim";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h.close();
});

function devUserCookieOf(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=`)) ?? null;
}

describe("GET /api/session", () => {
  it("a guest with no cookie gets kind: guest, signInAvailable, and guestTtlHours — and mints a guest cookie", async () => {
    const res = await callRoute(sessionRoute.GET, request("GET", "/api/session"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "guest", signInAvailable: true });
    expect(body).not.toHaveProperty("displayName");
    expect(typeof body.guestTtlHours).toBe("number");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`))).toBe(true);
  });

  it("signInAvailable is false in production", async () => {
    vi.stubEnv("GUEST_SESSION_SECRET", "a".repeat(32));
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "b".repeat(32));
    vi.stubEnv("NODE_ENV", "production");

    const res = await callRoute(sessionRoute.GET, request("GET", "/api/session"));

    expect((await res.json()).signInAvailable).toBe(false);
  });
});

describe("sign-in, session and sign-out round trip", () => {
  it("dev-sign-in mints a user cookie; GET /api/session then answers kind: user with that display name; sign-out clears it and the next GET is a guest again", async () => {
    const signInRes = await callRoute(
      devSignInRoute.POST,
      request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }),
    );
    expect(signInRes.status).toBe(200);
    expect(await signInRes.json()).toMatchObject({ kind: "user", displayName: "Asha Verma" });
    const userCookie = devUserCookieOf(signInRes);
    expect(userCookie).not.toBeNull();
    const cookieHeader = userCookie!.split(";")[0];

    const asUser = await callRoute(sessionRoute.GET, request("GET", "/api/session", { cookie: cookieHeader }));
    expect(await asUser.json()).toMatchObject({ kind: "user", displayName: "Asha Verma" });

    const signOutRes = await callRoute(
      signOutRoute.POST,
      request("POST", "/api/session/sign-out", { cookie: cookieHeader }),
    );
    expect(signOutRes.status).toBe(200);
    expect(await signOutRes.json()).toMatchObject({ kind: "guest" });
    const cleared = devUserCookieOf(signOutRes);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared?.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=;`)).toBe(true);

    // Sign-out is stateless (no server-side session store to revoke, same as claim's cleared guest
    // cookie): the signature itself stays valid until its own TTL. Max-Age=0 tells a real BROWSER to
    // drop the cookie; a raw replay of the old value still resolves, exactly as claim-session.ts's own
    // "a replay is harmless" comment documents for the guest cookie.
    const replayed = await callRoute(sessionRoute.GET, request("GET", "/api/session", { cookie: cookieHeader }));
    expect((await replayed.json()).kind).toBe("user");
  });

  it("signing in twice with the same display name reuses the same user — same id in both Set-Cookie values, and claim under the SECOND sign-in's cookie still re-owns a guest's data", async () => {
    const first = await callRoute(devSignInRoute.POST, request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }));
    const second = await callRoute(devSignInRoute.POST, request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }));

    // The cookie value is userId.issuedAt.signature — the response body alone can't prove this
    // (SessionOutput carries no id), so the id is read out of the signed cookie itself.
    const userIdOf = (res: Response) => devUserCookieOf(res)!.split(";")[0].split("=")[1].split(".")[0];
    expect(userIdOf(second)).toBe(userIdOf(first));

    const { cookie: existingGuestCookie, guestSessionId } = guestCookie();
    const document = await insertDocument(h.t, { type: "guest", guestSessionId }, new Date(Date.now() + 3_600_000));
    const secondCookieHeader = devUserCookieOf(second)!.split(";")[0];

    const claimRes = await callRoute(
      claimRoute.POST,
      request("POST", "/api/auth/claim", { cookie: `${secondCookieHeader}; ${existingGuestCookie}` }),
    );
    expect(claimRes.status).toBe(200);
    expect(await claimRes.json()).toEqual({ documents: 1, comparisons: 0, drafts: 0 });
    const asUser = await callRoute(documentsRoute.GET, request("GET", `/api/documents/${document.id}`, { cookie: secondCookieHeader }), {
      id: document.id,
    });
    expect(asUser.status).toBe(200);
  });

  it("claim right after sign-in, with an existing guest cookie, re-owns that guest's data", async () => {
    const { cookie: existingGuestCookie, guestSessionId } = guestCookie();
    const document = await insertDocument(h.t, { type: "guest", guestSessionId }, new Date(Date.now() + 3_600_000));

    const signInRes = await callRoute(
      devSignInRoute.POST,
      request("POST", "/api/auth/dev-sign-in", { cookie: existingGuestCookie, json: { displayName: "Asha Verma" } }),
    );
    const userCookieHeader = devUserCookieOf(signInRes)!.split(";")[0];

    const claimRes = await callRoute(
      claimRoute.POST,
      request("POST", "/api/auth/claim", { cookie: `${userCookieHeader}; ${existingGuestCookie}` }),
    );
    expect(claimRes.status).toBe(200);
    expect(await claimRes.json()).toEqual({ documents: 1, comparisons: 0, drafts: 0 });

    const asUser = await callRoute(documentsRoute.GET, request("GET", `/api/documents/${document.id}`, { cookie: userCookieHeader }), {
      id: document.id,
    });
    expect(asUser.status).toBe(200);
  });

  it("two different display names never see each other's session (no cross-principal bleed)", async () => {
    const asha = await callRoute(devSignInRoute.POST, request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }));
    const raj = await callRoute(devSignInRoute.POST, request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Raj Mehta" } }));
    const ashaCookie = devUserCookieOf(asha)!.split(";")[0];
    const rajCookie = devUserCookieOf(raj)!.split(";")[0];

    const asAsha = await callRoute(sessionRoute.GET, request("GET", "/api/session", { cookie: ashaCookie }));
    const asRaj = await callRoute(sessionRoute.GET, request("GET", "/api/session", { cookie: rajCookie }));

    expect((await asAsha.json()).displayName).toBe("Asha Verma");
    expect((await asRaj.json()).displayName).toBe("Raj Mehta");
  });
});

describe("POST /api/auth/dev-sign-in's wire body — the real route, not just the schema in isolation", () => {
  // Keys hard-coded here from the wire contract itself, not from session.ts's own return shape — a
  // route wired to a loosened contract (e.g. accidentally passthrough) would still
  // pass a contract-only test, since z.object's own strip behaviour is what's under test there. This
  // drives the real handler end to end so a mistake in *which* schema the route declares is caught too.
  it("the JSON body has exactly the spec's four keys, and never contains the signed-in user's own id", async () => {
    const res = await callRoute(
      devSignInRoute.POST,
      request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }),
    );

    const rawText = await res.text();
    const body = JSON.parse(rawText);
    expect(Object.keys(body).sort()).toEqual(["displayName", "guestTtlHours", "kind", "signInAvailable"]);

    const userId = devUserCookieOf(res)!.split(";")[0].split("=")[1].split(".")[0];
    expect(userId.length).toBeGreaterThan(0);
    expect(rawText).not.toContain(userId);
  });
});

describe("dev-sign-in validation", () => {
  it("rejects an empty (post-sanitize) display name with VALIDATION_FAILED, minting no user cookie", async () => {
    const res = await callRoute(devSignInRoute.POST, request("POST", "/api/auth/dev-sign-in", { json: { displayName: "   " } }));

    expect(res.status).toBe(400);
    expect(devUserCookieOf(res)).toBeNull();
  });

  it("rejects a client-sent userId field (strict body)", async () => {
    const res = await callRoute(
      devSignInRoute.POST,
      request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha", userId: deriveDevUserId("Someone Else") } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("production refusal", () => {
  it("POST /api/auth/dev-sign-in 404s in production", async () => {
    vi.stubEnv("GUEST_SESSION_SECRET", "a".repeat(32));
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "b".repeat(32));
    vi.stubEnv("NODE_ENV", "production");

    const res = await callRoute(devSignInRoute.POST, request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha" } }));

    expect(res.status).toBe(404);
  });
});
