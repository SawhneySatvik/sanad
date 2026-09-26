import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/server/core/env";
import {
  emailSignInAvailable,
  hasUsableUserSessionSecret,
  HOST_USER_SESSION_COOKIE_NAME,
  mintUserSession,
  readUserSession,
  requireUserSessionSecret,
  resolveUserPrincipalFromCookie,
  userSessionCookie,
  USER_SESSION_COOKIE_NAME,
  USER_SESSION_TTL_SECONDS,
} from "@/server/auth/user-session";

const VALID_SECRET = "u".repeat(32);
const USER_ID = "e1e1e1e1-0000-4000-8000-0000000000e1";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Mirrors user-session.ts's own hmacSign (including its "user-session:" prefix), so tests can
// construct cookies it would accept — isolates a specific check (id format, expiry) from "the
// signature is wrong too."
function signForTest(secret: string, userId: string, issuedAtRaw: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`user-session:${userId}.${issuedAtRaw}`).digest("base64url");
}

// The un-prefixed message session.ts's own guest-cookie HMAC signs — same shape, no domain tag.
function signUnprefixedForTest(secret: string, userId: string, issuedAtRaw: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`${userId}.${issuedAtRaw}`).digest("base64url");
}

beforeEach(() => {
  vi.stubEnv("USER_SESSION_SECRET", VALID_SECRET);
  vi.stubEnv("GUEST_SESSION_SECRET", "g".repeat(32));
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mintUserSession / readUserSession — round trip", () => {
  it("recovers the same user id from a cookie value mintUserSession produced", () => {
    const { cookieValue } = mintUserSession(USER_ID);
    expect(readUserSession(cookieValue)).toBe(USER_ID);
  });

  it("resolveUserPrincipalFromCookie wraps it into a user Principal", () => {
    const { cookieValue } = mintUserSession(USER_ID);
    expect(resolveUserPrincipalFromCookie(cookieValue)).toEqual({ type: "user", userId: USER_ID });
  });
});

describe("mintUserSession — the mint path throws on a missing/short secret; the read path never does", () => {
  it("throws a ConfigError when USER_SESSION_SECRET is unset", () => {
    vi.stubEnv("USER_SESSION_SECRET", "");
    expect(() => mintUserSession(USER_ID)).toThrow(ConfigError);
  });

  it("throws when USER_SESSION_SECRET is under 32 bytes", () => {
    vi.stubEnv("USER_SESSION_SECRET", "too-short");
    expect(() => mintUserSession(USER_ID)).toThrow(ConfigError);
  });

  it("readUserSession degrades to null (never throws) when the secret is missing — a mid-deploy env gap reads as guest, not a 500", () => {
    const { cookieValue } = mintUserSession(USER_ID);
    vi.stubEnv("USER_SESSION_SECRET", "");
    expect(() => readUserSession(cookieValue)).not.toThrow();
    expect(readUserSession(cookieValue)).toBeNull();
  });
});

describe("hasUsableUserSessionSecret / emailSignInAvailable", () => {
  it("is true for a usable secret, false for missing/short", () => {
    expect(hasUsableUserSessionSecret()).toBe(true);
    vi.stubEnv("USER_SESSION_SECRET", "short");
    expect(hasUsableUserSessionSecret()).toBe(false);
    vi.stubEnv("USER_SESSION_SECRET", "");
    expect(hasUsableUserSessionSecret()).toBe(false);
  });

  it("requires every Supabase env var plus a usable secret", () => {
    vi.stubEnv("SUPABASE_PROJECT_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("SUPABASE_JWKS_URL", "https://example.supabase.co/auth/v1/.well-known/jwks.json");
    expect(emailSignInAvailable()).toBe(true);

    vi.stubEnv("SUPABASE_JWKS_URL", "");
    expect(emailSignInAvailable()).toBe(false);
  });

  it("requireUserSessionSecret's own message never echoes the (absent) value, only the variable name", async () => {
    vi.stubEnv("USER_SESSION_SECRET", "");
    // requireUserSessionSecret throws synchronously; wrapping it in a resolved promise lets the
    // rejection assertion below run without a manual try/catch (which would silently pass if the
    // call stopped throwing at all).
    await expect(Promise.resolve().then(() => requireUserSessionSecret())).rejects.toMatchObject({
      variableName: "USER_SESSION_SECRET",
    });
  });
});

describe("domain separation and fail-closed equal secrets", () => {
  it("mintUserSession refuses (fails closed) when USER_SESSION_SECRET equals GUEST_SESSION_SECRET", async () => {
    vi.stubEnv("GUEST_SESSION_SECRET", VALID_SECRET);
    vi.stubEnv("USER_SESSION_SECRET", VALID_SECRET);
    await expect(Promise.resolve().then(() => mintUserSession(USER_ID))).rejects.toMatchObject({
      variableName: "USER_SESSION_SECRET",
    });
  });

  it("readUserSession refuses (returns null, never throws) when the secrets collide, even for an otherwise well-signed cookie", () => {
    vi.stubEnv("GUEST_SESSION_SECRET", "shared-secret-value-012345678901");
    vi.stubEnv("USER_SESSION_SECRET", "shared-secret-value-012345678901");
    const issuedAtRaw = String(nowSeconds());
    const signature = signForTest("shared-secret-value-012345678901", USER_ID, issuedAtRaw);
    expect(readUserSession(`${USER_ID}.${issuedAtRaw}.${signature}`)).toBeNull();
  });

  it("hasUsableUserSessionSecret / emailSignInAvailable are false when the secrets collide", () => {
    vi.stubEnv("GUEST_SESSION_SECRET", VALID_SECRET);
    vi.stubEnv("USER_SESSION_SECRET", VALID_SECRET);
    expect(hasUsableUserSessionSecret()).toBe(false);

    vi.stubEnv("SUPABASE_PROJECT_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("SUPABASE_JWKS_URL", "https://example.supabase.co/auth/v1/.well-known/jwks.json");
    expect(emailSignInAvailable()).toBe(false);
  });

  it("rejects a cookie signed over the un-prefixed message — the exact bytes session.ts's own guest-cookie HMAC signs, with the same secret", () => {
    const issuedAtRaw = String(nowSeconds());
    const signature = signUnprefixedForTest(VALID_SECRET, USER_ID, issuedAtRaw);
    expect(readUserSession(`${USER_ID}.${issuedAtRaw}.${signature}`)).toBeNull();
  });
});

describe("userSessionCookie", () => {
  it("sets HttpOnly, SameSite=Lax, Path=/, and Max-Age matching the account TTL", () => {
    const attrs = userSessionCookie("some-value");
    expect(attrs).toMatchObject({
      name: USER_SESSION_COOKIE_NAME,
      value: "some-value",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: USER_SESSION_TTL_SECONDS,
    });
  });

  it("is __Host-user_session in production and user_session elsewhere", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(userSessionCookie("v")).toMatchObject({ name: HOST_USER_SESSION_COOKIE_NAME, secure: true });
    vi.stubEnv("NODE_ENV", "test");
    expect(userSessionCookie("v")).toMatchObject({ name: USER_SESSION_COOKIE_NAME, secure: false });
  });
});

describe("readUserSession — tamper rejection", () => {
  it("rejects a cookie with a flipped signature character", () => {
    const { cookieValue } = mintUserSession(USER_ID);
    const [id, iat, sig] = cookieValue.split(".");
    const mid = Math.floor(sig.length / 2);
    const flipped = sig[mid] === "A" ? "B" : "A";
    expect(readUserSession(`${id}.${iat}.${sig.slice(0, mid)}${flipped}${sig.slice(mid + 1)}`)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    vi.stubEnv("USER_SESSION_SECRET", "a".repeat(32));
    const { cookieValue } = mintUserSession(USER_ID);
    vi.stubEnv("USER_SESSION_SECRET", "b".repeat(32));
    expect(readUserSession(cookieValue)).toBeNull();
  });

  it("rejects a well-signed cookie naming an id that isn't v4-shaped", () => {
    const notV4 = "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee";
    const issuedAtRaw = String(nowSeconds());
    const signature = signForTest(VALID_SECRET, notV4, issuedAtRaw);
    expect(readUserSession(`${notV4}.${issuedAtRaw}.${signature}`)).toBeNull();
  });

  it("rejects a cookie whose issued-at is older than the account session TTL, even though correctly signed", () => {
    const staleIssuedAt = String(nowSeconds() - USER_SESSION_TTL_SECONDS - 60);
    const signature = signForTest(VALID_SECRET, USER_ID, staleIssuedAt);
    expect(readUserSession(`${USER_ID}.${staleIssuedAt}.${signature}`)).toBeNull();
  });

  it("rejects a cookie whose issued-at is in the future beyond the clock-skew tolerance", () => {
    const futureIssuedAt = String(nowSeconds() + 3600);
    const signature = signForTest(VALID_SECRET, USER_ID, futureIssuedAt);
    expect(readUserSession(`${USER_ID}.${futureIssuedAt}.${signature}`)).toBeNull();
  });
});

describe("readUserSession — malformed input never throws", () => {
  it.each([["", null], ["null-ish", undefined], ["no dots", "no-dot-here"], ["garbage", "!!!not@@a##cookie$$"]])(
    "returns null for %s",
    (_label, value) => {
      expect(readUserSession(value as string | null | undefined)).toBeNull();
    },
  );

  it("never throws across malformed input", () => {
    const inputs = ["", null, undefined, "no-dot-here", "a.b.c", "a.b.c.d"];
    for (const input of inputs) expect(() => readUserSession(input as string | null | undefined)).not.toThrow();
  });
});
