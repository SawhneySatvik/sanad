import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/server/core/env";
import {
  GUEST_SESSION_COOKIE_NAME,
  GUEST_SESSION_TTL_SECONDS,
  HOST_GUEST_SESSION_COOKIE_NAME,
  createGuestSession,
  guestSessionCookie,
  guestSessionCookieName,
  readGuestSession,
  resolvePrincipalFromCookie,
} from "@/server/auth/session";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALID_SECRET = "a".repeat(32);
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Mirrors session.ts's own `hmacSign` exactly (same key encoding, same
// message shape) so tests can construct cookies session.ts itself would
// accept — used to pin checks (UUID format, issued-at expiry) independently
// of "the signature happens to be wrong too", which proves nothing about the
// specific check under test.
function signForTest(secret: string, guestSessionId: string, issuedAtRaw: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${guestSessionId}.${issuedAtRaw}`)
    .digest("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Returns a different base64url character than `sig`'s last character that
// decodes to the identical byte value (the last base64 character of a
// 32-byte HMAC-SHA256 digest carries 2 "don't care" padding bits — see
// session.ts's text-vs-decoded-bytes comment). Proves signatureMatches
// compares text, not decoded bytes.
function sameDecodedBytesLastCharVariant(sig: string): string {
  const lastChar = sig.at(-1);
  if (lastChar === undefined) throw new Error("signature must be non-empty");
  const index = BASE64URL_ALPHABET.indexOf(lastChar);
  const groupStart = index - (index % 4);
  const variantIndex = index === groupStart ? groupStart + 1 : groupStart;
  return sig.slice(0, -1) + BASE64URL_ALPHABET[variantIndex];
}

beforeEach(() => {
  // A valid, 32-byte secret by default so most tests exercise the normal
  // signing path rather than the ephemeral-fallback/warning path — tests
  // that specifically want the fallback override this per-test.
  vi.stubEnv("GUEST_SESSION_SECRET", VALID_SECRET);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createGuestSession", () => {
  it("returns a UUIDv4 guest session id and an id.issuedAt.signature cookie value", () => {
    const { guestSessionId, cookieValue } = createGuestSession();
    expect(guestSessionId).toMatch(UUID_V4_RE);
    const parts = cookieValue.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(guestSessionId);
    expect(parts[1]).toMatch(/^\d+$/);
    expect(Number(parts[1])).toBeCloseTo(nowSeconds(), -1);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("generates unique, correctly-formatted ids across 10,000 generations", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const { guestSessionId } = createGuestSession();
      expect(guestSessionId).toMatch(UUID_V4_RE);
      ids.add(guestSessionId);
    }
    expect(ids.size).toBe(10_000);
  });
});

describe("readGuestSession — round trip", () => {
  it("recovers the same guest session id from a cookie value it produced", () => {
    const { guestSessionId, cookieValue } = createGuestSession();
    expect(readGuestSession(cookieValue)).toBe(guestSessionId);
  });
});

describe("readGuestSession — tamper rejection", () => {
  it("rejects a cookie with a flipped middle character in the signature", () => {
    const { cookieValue } = createGuestSession();
    const [id, iat, sig] = cookieValue.split(".");
    const mid = Math.floor(sig.length / 2);
    const flipped = sig[mid] === "A" ? "B" : "A";
    const tampered = `${id}.${iat}.${sig.slice(0, mid)}${flipped}${sig.slice(mid + 1)}`;
    expect(readGuestSession(tampered)).toBeNull();
  });

  it("rejects a cookie whose id was altered (signature no longer matches)", () => {
    const { cookieValue } = createGuestSession();
    const [id, iat, sig] = cookieValue.split(".");
    const lastChar = id.at(-1);
    const tamperedId = id.slice(0, -1) + (lastChar === "0" ? "1" : "0");
    expect(readGuestSession(`${tamperedId}.${iat}.${sig}`)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    vi.stubEnv("GUEST_SESSION_SECRET", "a".repeat(32));
    const { cookieValue } = createGuestSession();
    vi.stubEnv("GUEST_SESSION_SECRET", "b".repeat(32));
    expect(readGuestSession(cookieValue)).toBeNull();
  });

  it("rejects a non-UUID id even when correctly signed with the current secret (pins the UUID format check, not just the signature check)", () => {
    const nonUuidId = "not-a-uuid-at-all";
    const issuedAtRaw = String(nowSeconds());
    const realSignature = signForTest(VALID_SECRET, nonUuidId, issuedAtRaw);
    expect(readGuestSession(`${nonUuidId}.${issuedAtRaw}.${realSignature}`)).toBeNull();
  });

  it("rejects a signature variant that decodes to the same bytes but differs in text (pins text comparison over decoded-byte comparison)", () => {
    const { cookieValue } = createGuestSession();
    const [id, iat, sig] = cookieValue.split(".");
    const variantSig = sameDecodedBytesLastCharVariant(sig);

    expect(variantSig).not.toBe(sig);
    expect(Buffer.from(variantSig, "base64url").equals(Buffer.from(sig, "base64url"))).toBe(true);
    expect(readGuestSession(`${id}.${iat}.${variantSig}`)).toBeNull();
  });

  it("rejects a cookie with a trailing extra segment after the signature", () => {
    const { cookieValue } = createGuestSession();
    expect(readGuestSession(`${cookieValue}.junk`)).toBeNull();
  });
});

describe("readGuestSession — malformed input never throws", () => {
  it("returns null for an empty string", () => {
    expect(readGuestSession("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(readGuestSession(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(readGuestSession(undefined)).toBeNull();
  });

  it("returns null for a value with no dot separator", () => {
    expect(readGuestSession("no-dot-here")).toBeNull();
  });

  it("returns null for the old 2-segment (pre-issued-at) format", () => {
    const fakeUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(readGuestSession(`${fakeUuid}.${"a".repeat(43)}`)).toBeNull();
  });

  it("returns null for a non-UUID id with an otherwise well-formed (but not actually valid) signature", () => {
    expect(readGuestSession(`not-a-uuid.${nowSeconds()}.${"a".repeat(43)}`)).toBeNull();
  });

  it("returns null for a truncated signature", () => {
    const { cookieValue } = createGuestSession();
    expect(readGuestSession(cookieValue.slice(0, -10))).toBeNull();
  });

  it("returns null for pure garbage input", () => {
    expect(readGuestSession("!!!not@@a##cookie$$")).toBeNull();
  });

  it("never throws across any malformed input above", () => {
    const inputs = ["", null, undefined, "no-dot-here", "a.b.c", "a.b.c.d", "!!!garbage!!!"];
    for (const input of inputs) {
      expect(() => readGuestSession(input as string | null | undefined)).not.toThrow();
    }
  });
});

describe("readGuestSession — server-side issued-at / TTL enforcement", () => {
  it("accepts a freshly-issued cookie", () => {
    const { guestSessionId, cookieValue } = createGuestSession();
    expect(readGuestSession(cookieValue)).toBe(guestSessionId);
  });

  it("rejects a cookie whose issued-at is older than the guest TTL, even though correctly signed", () => {
    const { guestSessionId } = createGuestSession();
    const staleIssuedAt = String(nowSeconds() - GUEST_SESSION_TTL_SECONDS - 60);
    const signature = signForTest(VALID_SECRET, guestSessionId, staleIssuedAt);
    expect(readGuestSession(`${guestSessionId}.${staleIssuedAt}.${signature}`)).toBeNull();
  });

  it("rejects a cookie with a tampered issued-at (signature no longer matches the altered value)", () => {
    const { cookieValue } = createGuestSession();
    const [id, iat, sig] = cookieValue.split(".");
    const tamperedIat = String(Number(iat) - 1);
    expect(readGuestSession(`${id}.${tamperedIat}.${sig}`)).toBeNull();
  });

  it("rejects a cookie whose issued-at is in the future beyond the clock-skew tolerance", () => {
    const { guestSessionId } = createGuestSession();
    const futureIssuedAt = String(nowSeconds() + 3600);
    const signature = signForTest(VALID_SECRET, guestSessionId, futureIssuedAt);
    expect(readGuestSession(`${guestSessionId}.${futureIssuedAt}.${signature}`)).toBeNull();
  });
});

describe("resolvePrincipalFromCookie", () => {
  it("resolves a guest principal from a valid cookie", () => {
    const { guestSessionId, cookieValue } = createGuestSession();
    expect(resolvePrincipalFromCookie(cookieValue)).toEqual({ type: "guest", guestSessionId });
  });

  it("returns null for a missing cookie", () => {
    expect(resolvePrincipalFromCookie(undefined)).toBeNull();
    expect(resolvePrincipalFromCookie(null)).toBeNull();
  });

  it("returns null for an invalid cookie", () => {
    expect(resolvePrincipalFromCookie("garbage")).toBeNull();
  });
});

describe("guestSessionCookie", () => {
  it("sets HttpOnly, SameSite=Lax, Path=/, and Max-Age matching the guest TTL", () => {
    const attrs = guestSessionCookie("some-cookie-value");
    expect(attrs.name).toBe(GUEST_SESSION_COOKIE_NAME);
    expect(attrs.value).toBe("some-cookie-value");
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe("lax");
    expect(attrs.path).toBe("/");
    expect(attrs.maxAge).toBe(GUEST_SESSION_TTL_SECONDS);
  });

  it("sets Secure only in production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(guestSessionCookie("v").secure).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(guestSessionCookie("v").secure).toBe(true);
  });

  it("is __Host-guest_session in production and guest_session elsewhere — the name always moving with Secure", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(guestSessionCookieName()).toBe(HOST_GUEST_SESSION_COOKIE_NAME);
    expect(HOST_GUEST_SESSION_COOKIE_NAME).toBe("__Host-guest_session");
    expect(guestSessionCookie("v")).toMatchObject({ name: "__Host-guest_session", secure: true, path: "/" });
    expect(guestSessionCookie("v")).not.toHaveProperty("domain");

    for (const mode of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", mode);
      expect(guestSessionCookieName()).toBe(GUEST_SESSION_COOKIE_NAME);
      expect(guestSessionCookie("v")).toMatchObject({ name: "guest_session", secure: false });
    }
  });
});

describe("GUEST_SESSION_TTL_SECONDS", () => {
  it("is within the 2-4 hour guest TTL range", () => {
    expect(GUEST_SESSION_TTL_SECONDS).toBeGreaterThanOrEqual(2 * 60 * 60);
    expect(GUEST_SESSION_TTL_SECONDS).toBeLessThanOrEqual(4 * 60 * 60);
  });
});

describe("production secret enforcement", () => {
  it("throws a typed ConfigError when GUEST_SESSION_SECRET is missing in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_SESSION_SECRET", "");
    expect(() => createGuestSession()).toThrow(ConfigError);
  });

  it("throws a typed ConfigError when GUEST_SESSION_SECRET is shorter than 32 bytes in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_SESSION_SECRET", "too-short-secret");
    expect(() => createGuestSession()).toThrow(ConfigError);
  });

  it("throws a typed ConfigError when GUEST_SESSION_SECRET is whitespace-only in production, even though it's 32+ bytes long", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_SESSION_SECRET", " ".repeat(40));
    expect(() => createGuestSession()).toThrow(ConfigError);
  });

  it("never includes the configured secret value in the thrown error's message", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_SESSION_SECRET", "recognizable-short-marker");
    let caught: unknown;
    try {
      createGuestSession();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).not.toContain("recognizable-short-marker");
  });

  it("the error message alone tells an operator what is wrong and what to set, without pointing into docs", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [secret, problem] of [
      ["", "is required in production"],
      ["a".repeat(31), "must be at least 32 bytes in production"],
    ] as const) {
      vi.stubEnv("GUEST_SESSION_SECRET", secret);
      expect(() => createGuestSession()).not.toThrow(/docs\//);
      expect(() => createGuestSession()).toThrow(`GUEST_SESSION_SECRET ${problem}.`);
      expect(() => createGuestSession()).toThrow(/set it to a random value of at least 32 bytes/);
    }
  });

  it("succeeds in production with a valid 32+ byte secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_SESSION_SECRET", "c".repeat(32));
    expect(() => createGuestSession()).not.toThrow();
  });
});

describe("ephemeral secret fallback outside production", () => {
  it("logs the fallback warning exactly once across many calls, and never logs the secret value", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GUEST_SESSION_SECRET", "recognizable-short-marker");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const freshSession = await import("@/server/auth/session");

    freshSession.createGuestSession();
    freshSession.createGuestSession();
    freshSession.readGuestSession("not-a-real-cookie-value");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls.flat().join(" ");
    expect(loggedText).not.toContain("recognizable-short-marker");
    warnSpy.mockRestore();
  });

  it("still round-trips a session created under the ephemeral fallback, within the same process", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GUEST_SESSION_SECRET", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const freshSession = await import("@/server/auth/session");

    const { guestSessionId, cookieValue } = freshSession.createGuestSession();
    expect(freshSession.readGuestSession(cookieValue)).toBe(guestSessionId);
  });

  it("uses a different ephemeral secret per process — a cookie from one fresh module instance is rejected by another (pins 'no hardcoded dev secret')", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GUEST_SESSION_SECRET", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.resetModules();
    const moduleA = await import("@/server/auth/session");
    const { cookieValue } = moduleA.createGuestSession();

    vi.resetModules();
    const moduleB = await import("@/server/auth/session");
    expect(moduleB.readGuestSession(cookieValue)).toBeNull();
  });
});

describe("rotation grace period via GUEST_SESSION_SECRET_PREVIOUS", () => {
  it("verifies a cookie signed with the previous secret once GUEST_SESSION_SECRET has rotated", () => {
    const oldSecret = "old-secret-".padEnd(32, "0");
    const newSecret = "new-secret-".padEnd(32, "1");

    vi.stubEnv("GUEST_SESSION_SECRET", oldSecret);
    const { guestSessionId, cookieValue } = createGuestSession();

    // Rotate: the old secret moves to "previous", a new one becomes current.
    vi.stubEnv("GUEST_SESSION_SECRET", newSecret);
    vi.stubEnv("GUEST_SESSION_SECRET_PREVIOUS", oldSecret);

    expect(readGuestSession(cookieValue)).toBe(guestSessionId);
  });
});
