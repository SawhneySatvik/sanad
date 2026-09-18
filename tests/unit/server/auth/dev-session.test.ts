import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDevSignInAdapter,
  deriveDevUserId,
  DEV_USER_SESSION_COOKIE_NAME,
  DEV_USER_SESSION_TTL_SECONDS,
  devUserSessionCookie,
  HOST_DEV_USER_SESSION_COOKIE_NAME,
  readDevUserSession,
  resolveUserPrincipalFromCookie,
} from "@/server/auth/dev-session";
import * as devSignInRoute from "@/app/api/auth/dev-sign-in/route";
import { createRouteHarness, callRoute, request, type RouteHarness } from "@tests/integration/routes/harness";

const VALID_SECRET = "d".repeat(32);
const DEV_USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Mirrors dev-session.ts's own hmacSign exactly, so tests can construct cookies it would accept —
// used to pin checks (id format, issued-at expiry) independently of "the signature happens to be
// wrong too", which would prove nothing about the specific check under test.
function signForTest(secret: string, userId: string, issuedAtRaw: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${userId}.${issuedAtRaw}`).digest("base64url");
}

beforeEach(() => {
  vi.stubEnv("DEV_SESSION_SECRET", VALID_SECRET);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deriveDevUserId", () => {
  it("is deterministic: the same display name always derives the same id", () => {
    expect(deriveDevUserId("Asha Verma")).toBe(deriveDevUserId("Asha Verma"));
  });

  it("gives different names different ids", () => {
    expect(deriveDevUserId("Asha Verma")).not.toBe(deriveDevUserId("Raj Verma"));
  });

  it("always matches the id format readDevUserSession accepts", () => {
    for (const name of ["Asha", "a very long display name indeed", "名前"]) {
      expect(deriveDevUserId(name)).toMatch(DEV_USER_ID_RE);
    }
  });
});

describe("createDevSignInAdapter / readDevUserSession — round trip", () => {
  it("recovers the same user id from a cookie value the adapter minted", () => {
    const userId = deriveDevUserId("Asha Verma");
    const attrs = createDevSignInAdapter().signIn(userId);
    expect(readDevUserSession(attrs.value)).toBe(userId);
  });

  it("resolveUserPrincipalFromCookie wraps it into a user Principal", () => {
    const userId = deriveDevUserId("Asha Verma");
    const attrs = createDevSignInAdapter().signIn(userId);
    expect(resolveUserPrincipalFromCookie(attrs.value)).toEqual({ type: "user", userId });
  });
});

describe("devUserSessionCookie", () => {
  it("sets HttpOnly, SameSite=Lax, Path=/, and Max-Age matching the dev TTL", () => {
    const attrs = devUserSessionCookie("some-value");
    expect(attrs).toMatchObject({
      name: DEV_USER_SESSION_COOKIE_NAME,
      value: "some-value",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: DEV_USER_SESSION_TTL_SECONDS,
    });
  });

  it("is __Host-dev_user_session in production and dev_user_session elsewhere", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(devUserSessionCookie("v")).toMatchObject({ name: HOST_DEV_USER_SESSION_COOKIE_NAME, secure: true });
    vi.stubEnv("NODE_ENV", "test");
    expect(devUserSessionCookie("v")).toMatchObject({ name: DEV_USER_SESSION_COOKIE_NAME, secure: false });
  });
});

describe("readDevUserSession — tamper rejection", () => {
  it("rejects a cookie with a flipped signature character", () => {
    const attrs = createDevSignInAdapter().signIn(deriveDevUserId("Asha"));
    const [id, iat, sig] = attrs.value.split(".");
    const mid = Math.floor(sig.length / 2);
    const flipped = sig[mid] === "A" ? "B" : "A";
    expect(readDevUserSession(`${id}.${iat}.${sig.slice(0, mid)}${flipped}${sig.slice(mid + 1)}`)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    vi.stubEnv("DEV_SESSION_SECRET", "a".repeat(32));
    const attrs = createDevSignInAdapter().signIn(deriveDevUserId("Asha"));
    vi.stubEnv("DEV_SESSION_SECRET", "b".repeat(32));
    expect(readDevUserSession(attrs.value)).toBeNull();
  });

  it("rejects a well-signed cookie naming an id that was never derived by deriveDevUserId (wrong version/variant) — pins the id-format check, not just the signature", () => {
    // A guest session's own v4-style id, correctly signed by the SAME dev secret — proves this is
    // rejected on format, not on signature.
    const guestShapedId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const issuedAtRaw = String(nowSeconds());
    const signature = signForTest(VALID_SECRET, guestShapedId, issuedAtRaw);
    expect(readDevUserSession(`${guestShapedId}.${issuedAtRaw}.${signature}`)).toBeNull();
  });

  it("rejects a cookie whose issued-at is older than the dev session TTL, even though correctly signed", () => {
    const userId = deriveDevUserId("Asha");
    const staleIssuedAt = String(nowSeconds() - DEV_USER_SESSION_TTL_SECONDS - 60);
    const signature = signForTest(VALID_SECRET, userId, staleIssuedAt);
    expect(readDevUserSession(`${userId}.${staleIssuedAt}.${signature}`)).toBeNull();
  });

  it("rejects a cookie whose issued-at is in the future beyond the clock-skew tolerance", () => {
    const userId = deriveDevUserId("Asha");
    const futureIssuedAt = String(nowSeconds() + 3600);
    const signature = signForTest(VALID_SECRET, userId, futureIssuedAt);
    expect(readDevUserSession(`${userId}.${futureIssuedAt}.${signature}`)).toBeNull();
  });
});

describe("readDevUserSession — malformed input never throws", () => {
  it.each([["", null], ["null-ish", undefined], ["no dots", "no-dot-here"], ["garbage", "!!!not@@a##cookie$$"]])(
    "returns null for %s",
    (_label, value) => {
      expect(readDevUserSession(value as string | null | undefined)).toBeNull();
    },
  );

  it("never throws across malformed input", () => {
    const inputs = ["", null, undefined, "no-dot-here", "a.b.c", "a.b.c.d"];
    for (const input of inputs) expect(() => readDevUserSession(input as string | null | undefined)).not.toThrow();
  });
});

describe("production refusal", () => {
  it("createDevSignInAdapter throws in production, and does not throw outside it (positive control)", () => {
    expect(() => createDevSignInAdapter()).not.toThrow();

    vi.stubEnv("NODE_ENV", "production");
    expect(() => createDevSignInAdapter()).toThrow();
  });

  it("POST /api/auth/dev-sign-in 404s in production", async () => {
    const h: RouteHarness = await createRouteHarness();
    try {
      // Unrelated to what this test checks, but every route hashes the caller's IP for rate-limiting
      // (ip-hash.ts) and, with no guest cookie on this request, mints a fresh guest session
      // (session.ts) — both need a real secret in production. Stubbed here purely to isolate the
      // dev-sign-in 404 itself.
      vi.stubEnv("GUEST_SESSION_SECRET", "e".repeat(32));
      vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "f".repeat(32));
      vi.stubEnv("NODE_ENV", "production");
      const res = await callRoute(
        devSignInRoute.POST,
        request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }),
      );
      expect(res.status).toBe(404);
      // A guest cookie may still be minted (principal resolution runs before the service throws) —
      // what matters here is that no dev user-session cookie is ever set.
      expect(res.headers.getSetCookie().some((c) => c.includes("dev_user_session"))).toBe(false);
    } finally {
      await h.close();
    }
  });

  // Stronger than "the route 404s" above: the resolver itself must refuse the signature, so even a
  // stale cookie that reaches a production request (never minted by this process, since the adapter
  // above refuses to construct there) can never verify. Red-proven: the identical cookie DOES verify
  // outside production, so only the production short-circuit blocks it.
  it("a fallback-signed dev-sign-in cookie never resolves to a user id in production (red-proven)", () => {
    vi.stubEnv("DEV_SESSION_SECRET", ""); // unset: resolveDevSecret falls back to the ephemeral per-process secret
    const userId = deriveDevUserId("Asha Verma");
    const attrs = createDevSignInAdapter().signIn(userId); // signed under that ephemeral fallback

    expect(readDevUserSession(attrs.value)).toBe(userId); // sanity: the cookie is genuinely valid outside production

    vi.stubEnv("NODE_ENV", "production");
    expect(readDevUserSession(attrs.value)).toBeNull();
  });
});
