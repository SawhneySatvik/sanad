// route()'s userSession opt-in (dev-sign-in "set", sign-in/up "set-account", sign-out "clear" only —
// restricted at the file path by tests/architecture/route-conventions.ts, not tested here): the
// cookie is derived from run()'s result and appended only once run() and the response contract both
// succeed; it is independent of the guest cookie principal resolution may also mint in the same
// response.

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deriveDevUserId, DEV_USER_SESSION_COOKIE_NAME } from "@/server/auth/dev-session";
import { GUEST_SESSION_COOKIE_NAME } from "@/server/auth/session";
import { HOST_USER_SESSION_COOKIE_NAME, USER_SESSION_COOKIE_NAME } from "@/server/auth/user-session";
import { route } from "@/server/http/handler";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "@tests/integration/routes/harness";

const Result = z.object({ ok: z.boolean() });
const ACCOUNT_USER_ID = "c1c1c1c1-0000-4000-8000-0000000000c1";

let h: RouteHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.unstubAllEnvs();
});

function userSessionCookieOf(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=`)) ?? null;
}

function accountSessionCookieOf(res: Response): string | null {
  return (
    res.headers.getSetCookie().find((c) => c.startsWith(`${USER_SESSION_COOKIE_NAME}=`) || c.startsWith(`${HOST_USER_SESSION_COOKIE_NAME}=`)) ?? null
  );
}

describe('userSession: "set"', () => {
  it("appends a user-session cookie signing the userId run() returned, and toWire strips userId from the JSON body", async () => {
    h = await createRouteHarness();
    const userId = deriveDevUserId("Asha Verma");
    const setsSession = route({
      usesLlm: false,
      userSession: "set",
      response: Result,
      run: async () => ({ ok: true, userId }),
    });

    const res = await callRoute(setsSession, request("POST", "/api/test"));

    expect(await res.json()).toEqual({ ok: true });
    const cookie = userSessionCookieOf(res);
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(new RegExp(`^${DEV_USER_SESSION_COOKIE_NAME}=${userId}\\.`));
  });

  it("mints both the freshly minted guest cookie AND the user cookie in one response — neither suppresses the other", async () => {
    h = await createRouteHarness();
    const userId = deriveDevUserId("Asha Verma");
    const setsSession = route({
      usesLlm: false,
      userSession: "set",
      response: Result,
      run: async () => ({ ok: true, userId }),
    });

    // No cookie on the request at all, so principal resolution mints a fresh guest session too.
    const res = await callRoute(setsSession, request("POST", "/api/test"));

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(cookies).toHaveLength(2);
  });

  it("never sets the cookie when run() throws", async () => {
    h = await createRouteHarness();
    const throws = route({
      usesLlm: false,
      userSession: "set",
      response: Result,
      run: async () => {
        throw new Error("boom");
      },
    });

    const res = await callRoute(throws, request("POST", "/api/test"));

    expect(res.status).toBe(500);
    expect(userSessionCookieOf(res)).toBeNull();
  });

  it("never sets the cookie when the response fails its own contract", async () => {
    h = await createRouteHarness();
    const badContract = route({
      usesLlm: false,
      userSession: "set",
      response: Result,
      run: async () => ({ ok: "not-a-boolean", userId: deriveDevUserId("Asha") }),
    });

    const res = await callRoute(badContract, request("POST", "/api/test"));

    expect(res.status).toBe(500);
    expect(userSessionCookieOf(res)).toBeNull();
  });

  it("fails loudly (a 500, never a silent skip) when run() forgets to return a userId — a wiring bug, not a request error", async () => {
    h = await createRouteHarness();
    const forgotUserId = route({ usesLlm: false, userSession: "set", response: Result, run: async () => ({ ok: true }) });

    const res = await callRoute(forgotUserId, request("POST", "/api/test"));

    expect(res.status).toBe(500);
    expect(userSessionCookieOf(res)).toBeNull();
  });
});

describe('userSession: "set-account"', () => {
  it("appends an account-session cookie signing the userId run() returned, and toWire strips userId from the JSON body", async () => {
    vi.stubEnv("USER_SESSION_SECRET", "a".repeat(32));
    h = await createRouteHarness();
    const setsSession = route({
      usesLlm: false,
      userSession: "set-account",
      response: Result,
      run: async () => ({ ok: true, userId: ACCOUNT_USER_ID }),
    });

    const res = await callRoute(setsSession, request("POST", "/api/test"));

    expect(await res.json()).toEqual({ ok: true });
    const cookie = accountSessionCookieOf(res);
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(new RegExp(`^${USER_SESSION_COOKIE_NAME}=${ACCOUNT_USER_ID}\\.`));
    // Never the dev cookie — a real sign-in mints only its own cookie kind.
    expect(userSessionCookieOf(res)).toBeNull();
  });

  it("never sets the cookie when run() throws", async () => {
    vi.stubEnv("USER_SESSION_SECRET", "a".repeat(32));
    h = await createRouteHarness();
    const throws = route({
      usesLlm: false,
      userSession: "set-account",
      response: Result,
      run: async () => {
        throw new Error("boom");
      },
    });

    const res = await callRoute(throws, request("POST", "/api/test"));

    expect(res.status).toBe(500);
    expect(accountSessionCookieOf(res)).toBeNull();
  });
});

describe('userSession: "clear"', () => {
  it("appends Max-Age=0 dev AND account cookies once run() succeeds — sign-out doesn't know which kind the caller had", async () => {
    h = await createRouteHarness();
    const clearsSession = route({ usesLlm: false, userSession: "clear", response: Result, run: async () => ({ ok: true }) });

    const res = await callRoute(clearsSession, request("POST", "/api/test"));

    const devCookie = userSessionCookieOf(res);
    const accountCookie = accountSessionCookieOf(res);
    expect(devCookie).not.toBeNull();
    expect(devCookie).toContain("Max-Age=0");
    expect(devCookie?.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(accountCookie).not.toBeNull();
    expect(accountCookie).toContain("Max-Age=0");
    expect(accountCookie?.startsWith(`${USER_SESSION_COOKIE_NAME}=;`)).toBe(true);
  });

  it("never clears on an error", async () => {
    h = await createRouteHarness();
    const throws = route({
      usesLlm: false,
      userSession: "clear",
      response: Result,
      run: async () => {
        throw new Error("boom");
      },
    });

    const res = await callRoute(throws, request("POST", "/api/test"));

    expect(res.status).toBe(500);
    expect(userSessionCookieOf(res)).toBeNull();
    expect(accountSessionCookieOf(res)).toBeNull();
  });

  it("clearing does not disturb an existing guest cookie in the same response", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const clearsSession = route({ usesLlm: false, userSession: "clear", response: Result, run: async () => ({ ok: true }) });

    const res = await callRoute(clearsSession, request("POST", "/api/test", { cookie }));

    // The request's own guest cookie was already valid, so nothing guest-related is minted — only
    // the two user-session clears should appear.
    expect(res.headers.getSetCookie()).toHaveLength(2);
    expect(userSessionCookieOf(res)).not.toBeNull();
    expect(accountSessionCookieOf(res)).not.toBeNull();
  });
});

describe("routes that do not opt in", () => {
  it("never carry a user-session cookie", async () => {
    h = await createRouteHarness();
    const plain = route({ usesLlm: false, response: Result, run: async () => ({ ok: true }) });

    const res = await callRoute(plain, request("POST", "/api/test"));

    expect(userSessionCookieOf(res)).toBeNull();
  });
});
