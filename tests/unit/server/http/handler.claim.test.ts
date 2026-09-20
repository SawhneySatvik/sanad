// route()'s claim opt-in (POST /api/auth/claim only): `claim` carries both identities, read
// independently from the auth hook and the signed cookie; non-opted routes never see it; the guest
// cookie is cleared only on a successful response; nothing else in a request is identity.

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { GUEST_SESSION_COOKIE_NAME } from "@/server/auth/session";
import { AppError } from "@/server/core/errors";
import {
  callRoute,
  createRouteHarness,
  guestCookie,
  mintedCookie,
  request,
  userA,
  userB,
  type RouteHarness,
} from "@tests/integration/routes/harness";
import { clearedGuestSessionCookie } from "@/server/http/claim-session";
import { route } from "@/server/http/handler";

const Identities = z.object({ user: z.string().nullable(), guest: z.string().nullable() });

let h: RouteHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// A claim-shaped route that answers with the identities it was given.
const whoClaims = route({
  claimSession: true,
  usesLlm: false,
  response: Identities,
  run: async ({ claim }) => ({ user: claim.user?.userId ?? null, guest: claim.guest?.guestSessionId ?? null }),
});

describe("claimSession: true", () => {
  it("hands run BOTH identities — the signed-in user AND the guest cookie, not short-circuited by the user", async () => {
    h = await createRouteHarness();
    const guest = guestCookie();
    h.signIn(userA);

    const res = await callRoute(whoClaims, request("POST", "/api/auth/claim", { cookie: guest.cookie }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: userA.userId, guest: guest.guestSessionId });
  });

  it("asks the auth hook exactly ONCE per claim request — claim.user is the answer the principal came from", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const guest = guestCookie();
    let principalUser: string | null = null;
    const withPrincipal = route({
      claimSession: true,
      usesLlm: false,
      response: Identities,
      run: async ({ claim, principal }) => {
        principalUser = principal.type === "user" ? principal.userId : null;
        return { user: claim.user?.userId ?? null, guest: claim.guest?.guestSessionId ?? null };
      },
    });
    const before = h.authCalls();

    const res = await callRoute(withPrincipal, request("POST", "/api/auth/claim", { cookie: guest.cookie }));

    expect(h.authCalls() - before).toBe(1);
    expect(await res.json()).toEqual({ user: userA.userId, guest: guest.guestSessionId });
    expect(principalUser).toBe(userA.userId);
  });

  it("reports each identity as null when it is absent — never invented", async () => {
    h = await createRouteHarness();
    const guest = guestCookie();

    const noUser = await callRoute(whoClaims, request("POST", "/api/auth/claim", { cookie: guest.cookie }));
    h.signIn(userA);
    const noGuest = await callRoute(whoClaims, request("POST", "/api/auth/claim"));

    expect(await noUser.json()).toEqual({ user: null, guest: guest.guestSessionId });
    expect(await noGuest.json()).toEqual({ user: userA.userId, guest: null });
  });

  it("identities named in headers, the query, the body or unsigned cookies are ignored", async () => {
    h = await createRouteHarness();
    const real = guestCookie();
    const other = guestCookie();
    const claimWithBody = route({
      claimSession: true,
      usesLlm: false,
      body: z.object({}).passthrough(),
      response: Identities,
      run: async ({ claim }) => ({ user: claim.user?.userId ?? null, guest: claim.guest?.guestSessionId ?? null }),
    });
    const spoof = (cookie: string) =>
      request("POST", `/api/auth/claim?userId=${userB.userId}&guestSessionId=${other.guestSessionId}`, {
        headers: {
          "x-user-id": userB.userId,
          "x-guest-session-id": other.guestSessionId,
          authorization: `Bearer ${userB.userId}`,
          cookie,
        },
        json: { userId: userB.userId, guestSessionId: other.guestSessionId, user: userB },
      });

    const withRealCookie = await callRoute(claimWithBody, spoof(`guest_session_id=${other.guestSessionId}; ${real.cookie}`));
    const withoutRealCookie = await callRoute(
      claimWithBody,
      spoof(`guest_session_id=${other.guestSessionId}; user_id=${userB.userId}; ${GUEST_SESSION_COOKIE_NAME}=${other.guestSessionId}`),
    );

    expect(await withRealCookie.json()).toEqual({ user: null, guest: real.guestSessionId });
    expect(await withoutRealCookie.json()).toEqual({ user: null, guest: null });
  });
});

describe("routes that do not opt in", () => {
  it("never receive claim — their run args are exactly { deps, principal, params, query, body }", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    let keys: string[] = [];
    const plain = route({
      usesLlm: false,
      response: z.object({ ok: z.boolean() }),
      run: async (args) => {
        keys = Object.keys(args).sort();
        return { ok: true };
      },
    });

    const res = await callRoute(plain, request("POST", "/api/test", { cookie: guestCookie().cookie }));

    expect(res.status).toBe(200);
    expect(keys).toEqual(["body", "deps", "params", "principal", "query"]);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("clearsGuestSession: true", () => {
  const cleared = clearedGuestSessionCookie();

  function claimRoute(outcome: "ok" | "rejects" | "breaks contract") {
    return route({
      claimSession: true,
      clearsGuestSession: true,
      usesLlm: false,
      body: z.strictObject({}),
      response: z.object({ moved: z.number() }),
      run: async () => {
        if (outcome === "rejects") throw new AppError("VALIDATION_FAILED", "no user");
        return outcome === "ok" ? { moved: 3 } : { moved: "three" };
      },
    });
  }

  it("a 200 answers with exactly the cleared guest cookie (Max-Age=0, same attributes as the minted one)", async () => {
    h = await createRouteHarness();
    h.signIn(userA);

    const res = await callRoute(claimRoute("ok"), request("POST", "/api/auth/claim", { cookie: guestCookie().cookie, json: {} }));

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([cleared]);
    expect(cleared).toMatch(new RegExp(`^${GUEST_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`));
  });

  it("even when the request had no session to begin with, a 200 carries only the clearing cookie — never a freshly minted one", async () => {
    h = await createRouteHarness();

    const res = await callRoute(claimRoute("ok"), request("POST", "/api/auth/claim", { json: {} }));

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([cleared]);
  });

  it("never clears on an error: a rejected claim, a broken response contract, a bad body", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const { cookie } = guestCookie();
    const send = (outcome: "ok" | "rejects" | "breaks contract", json: unknown = {}) =>
      callRoute(claimRoute(outcome), request("POST", "/api/auth/claim", { cookie, json }));

    const responses = [await send("rejects"), await send("breaks contract"), await send("ok", { extra: 1 })];

    expect(responses.map((r) => r.status)).toEqual([400, 500, 400]);
    for (const res of responses) expect(res.headers.getSetCookie()).not.toContain(cleared);
    expect(responses.every((res) => mintedCookie(res) === null)).toBe(true);
  });

  it("an error response on a claim route with no session still mints one, as every route does", async () => {
    h = await createRouteHarness();

    const res = await callRoute(claimRoute("rejects"), request("POST", "/api/auth/claim", { json: {} }));

    expect(res.status).toBe(400);
    expect(mintedCookie(res)).not.toBeNull();
    expect(res.headers.getSetCookie()).not.toContain(cleared);
  });
});
