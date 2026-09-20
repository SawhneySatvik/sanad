import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDevSignInAdapter,
  deriveDevUserId,
  DEV_USER_SESSION_COOKIE_NAME,
  HOST_DEV_USER_SESSION_COOKIE_NAME,
  readDevUserSession,
} from "@/server/auth/dev-session";
import { createGuestSession, GUEST_SESSION_COOKIE_NAME, guestSessionCookie } from "@/server/auth/session";
import {
  clearedUserSessionCookie,
  mintedUserSessionCookie,
  readCookie,
  resolveRequestPrincipal,
  serializeCookie,
  type AuthenticateUser,
} from "@/server/http/principal";

afterEach(() => {
  vi.unstubAllEnvs();
});

const noUser: AuthenticateUser = async () => null;
const USER = { type: "user", userId: "a1a1a1a1-0000-4000-8000-0000000000a1" } as const;

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/test", { headers });
}

describe("readCookie", () => {
  it("finds a cookie among others, first occurrence winning", () => {
    expect(readCookie("a=1; guest_session=x.y.z; b=2", "guest_session")).toBe("x.y.z");
    expect(readCookie("guest_session=first;guest_session=second", "guest_session")).toBe("first");
    expect(readCookie("a=b=c", "a")).toBe("b=c");
  });

  it("does not match a cookie whose name merely contains the name", () => {
    expect(readCookie("xguest_session=1; guest_session_id=2", "guest_session")).toBeNull();
    expect(readCookie(null, "guest_session")).toBeNull();
  });
});

describe("resolveRequestPrincipal", () => {
  it("mints a guest session, with its Set-Cookie, when the request has none", async () => {
    const resolved = await resolveRequestPrincipal(requestWith({}), noUser);

    expect(resolved.principal.type).toBe("guest");
    const id = resolved.principal.type === "guest" ? resolved.principal.guestSessionId : "";
    expect(resolved.setCookie).toMatch(new RegExp(`^${GUEST_SESSION_COOKIE_NAME}=${id}\\.`));
  });

  it("reads the guest from a valid signed cookie, minting nothing", async () => {
    const session = createGuestSession();

    const resolved = await resolveRequestPrincipal(
      requestWith({ cookie: `${GUEST_SESSION_COOKIE_NAME}=${session.cookieValue}` }),
      noUser,
    );

    expect(resolved).toEqual({
      principal: { type: "guest", guestSessionId: session.guestSessionId },
      setCookie: null,
    });
  });

  it("the auth hook's user wins over a guest cookie", async () => {
    const session = createGuestSession();

    const resolved = await resolveRequestPrincipal(
      requestWith({ cookie: `${GUEST_SESSION_COOKIE_NAME}=${session.cookieValue}` }),
      async () => USER,
    );

    expect(resolved).toEqual({ principal: USER, setCookie: null });
  });

  it("identity-shaped headers and unsigned cookies are ignored — the caller is a new guest", async () => {
    const resolved = await resolveRequestPrincipal(
      requestWith({
        "x-user-id": USER.userId,
        authorization: `Bearer ${USER.userId}`,
        cookie: `user_id=${USER.userId}; ${GUEST_SESSION_COOKIE_NAME}=${USER.userId}`,
      }),
      noUser,
    );

    expect(resolved.principal.type).toBe("guest");
    expect(resolved.principal).not.toMatchObject({ guestSessionId: USER.userId });
    expect(resolved.setCookie).not.toBeNull();
  });

  it("a valid dev-sign-in user cookie resolves ahead of a guest cookie, but the auth hook's own user still wins over it", async () => {
    const userId = deriveDevUserId("Asha Verma");
    const devCookie = createDevSignInAdapter().signIn(userId);
    const guestSession = createGuestSession();
    const header = `${DEV_USER_SESSION_COOKIE_NAME}=${devCookie.value}; ${GUEST_SESSION_COOKIE_NAME}=${guestSession.cookieValue}`;

    const asDevUser = await resolveRequestPrincipal(requestWith({ cookie: header }), noUser);
    expect(asDevUser).toEqual({ principal: { type: "user", userId }, setCookie: null });

    const asHookUser = await resolveRequestPrincipal(requestWith({ cookie: header }), async () => USER);
    expect(asHookUser).toEqual({ principal: USER, setCookie: null });
  });

  it("a tampered dev-sign-in cookie falls back to the guest cookie, never an error", async () => {
    const guestSession = createGuestSession();
    const header = `${DEV_USER_SESSION_COOKIE_NAME}=not-a-real-value; ${GUEST_SESSION_COOKIE_NAME}=${guestSession.cookieValue}`;

    const resolved = await resolveRequestPrincipal(requestWith({ cookie: header }), noUser);

    expect(resolved).toEqual({
      principal: { type: "guest", guestSessionId: guestSession.guestSessionId },
      setCookie: null,
    });
  });

  // The fixture above ("not-a-real-value") never reaches the HMAC check at all — it dies on the
  // three-part split first. This one is well-formed (a real id and issued-at, genuinely signed) with
  // only the signature bytes corrupted, so it's the signature check itself, not the format check,
  // that must fall back here.
  it("a well-formed dev-sign-in cookie with one flipped signature character falls back to the guest cookie — proves the signature check, not just the format check", async () => {
    const userId = deriveDevUserId("Asha Verma");
    const devCookie = createDevSignInAdapter().signIn(userId);
    const [id, issuedAt, signature] = devCookie.value.split(".");
    const mid = Math.floor(signature.length / 2);
    const flipped = signature[mid] === "A" ? "B" : "A";
    const tamperedValue = `${id}.${issuedAt}.${signature.slice(0, mid)}${flipped}${signature.slice(mid + 1)}`;

    const guestSession = createGuestSession();
    const header = `${DEV_USER_SESSION_COOKIE_NAME}=${tamperedValue}; ${GUEST_SESSION_COOKIE_NAME}=${guestSession.cookieValue}`;

    const resolved = await resolveRequestPrincipal(requestWith({ cookie: header }), noUser);

    expect(resolved).toEqual({
      principal: { type: "guest", guestSessionId: guestSession.guestSessionId },
      setCookie: null,
    });

    // Positive control: the SAME cookie, unflipped, resolves to the user — proves the flip is what
    // triggers the fallback, not something else about this fixture.
    const untamperedHeader = `${DEV_USER_SESSION_COOKIE_NAME}=${devCookie.value}; ${GUEST_SESSION_COOKIE_NAME}=${guestSession.cookieValue}`;
    const untamperedResolved = await resolveRequestPrincipal(requestWith({ cookie: untamperedHeader }), noUser);
    expect(untamperedResolved.principal).toEqual({ type: "user", userId });
  });

  // Exercised through the full request-resolution path, not just readDevUserSession directly (see
  // dev-session.test.ts): a fallback-signed cookie sent under the production __Host- cookie name must
  // never resolve to a user, even though the identical cookie resolves correctly outside production —
  // proving the resolver's own guard, not merely that the wrong cookie name got ignored.
  it("a fallback-signed dev-sign-in cookie sent under the production cookie name never resolves to a user principal in production", async () => {
    const userId = deriveDevUserId("Asha Verma");
    const devCookie = createDevSignInAdapter().signIn(userId); // ambient DEV_SESSION_SECRET is unset in this suite: the ephemeral fallback

    const outsideProduction = await resolveRequestPrincipal(
      requestWith({ cookie: `${DEV_USER_SESSION_COOKIE_NAME}=${devCookie.value}` }),
      noUser,
    );
    expect(outsideProduction.principal).toEqual({ type: "user", userId });

    vi.stubEnv("GUEST_SESSION_SECRET", "e".repeat(32));
    vi.stubEnv("NODE_ENV", "production");
    const inProduction = await resolveRequestPrincipal(
      requestWith({ cookie: `${HOST_DEV_USER_SESSION_COOKIE_NAME}=${devCookie.value}` }),
      noUser,
    );
    expect(inProduction.principal.type).toBe("guest");
  });
});

describe("mintedUserSessionCookie / clearedUserSessionCookie", () => {
  it("mints a cookie readDevUserSession accepts, naming the given userId", () => {
    const userId = deriveDevUserId("Raj Mehta");

    const cookie = mintedUserSessionCookie(userId);

    expect(cookie).toMatch(new RegExp(`^${DEV_USER_SESSION_COOKIE_NAME}=${userId}\\.`));
    const value = cookie.split(";")[0].split("=").slice(1).join("=");
    expect(readDevUserSession(value)).toBe(userId);
  });

  it("clears with Max-Age=0 and no value", () => {
    expect(clearedUserSessionCookie()).toBe(`${DEV_USER_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  });
});

describe("serializeCookie", () => {
  it("writes every attribute session.ts specifies", () => {
    expect(serializeCookie({ ...guestSessionCookie("v"), secure: true })).toBe(
      `${GUEST_SESSION_COOKIE_NAME}=v; Path=/; Max-Age=10800; HttpOnly; SameSite=Lax; Secure`,
    );
  });
});
