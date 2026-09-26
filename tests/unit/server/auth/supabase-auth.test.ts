// Fakes only at the HTTP boundary (a stubbed global fetch) — the JWT itself is a real ES256
// key pair generated with node:crypto, never a canned fixture, so signature verification is
// genuinely exercised, not assumed.

import { createHmac, randomBytes, randomUUID, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signIn, signUp, verifySupabaseAccessToken } from "@/server/auth/supabase-auth";
import { AppError } from "@/server/core/errors";

const PROJECT_URL = "https://project.supabase.co";
const KID = "test-signing-key";
const USER_ID = "f1f1f1f1-0000-4000-8000-0000000000f1";
const EMAIL = "asha@example.com";
const PASSWORD = "correct horse battery staple";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(payload: Record<string, unknown>, opts: { kid?: string; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? "ES256", kid: opts.kid ?? KID, typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" } as never);
  return `${signingInput}.${base64url(signature)}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: USER_ID,
    email: EMAIL,
    iss: `${PROJECT_URL}/auth/v1`,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 5,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let jwksUrl: string;
let authHandler: ((path: string, body: unknown) => Response) | null = null;
let jwksKeys: unknown[];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === jwksUrl) return jsonResponse(200, { keys: jwksKeys });
      if (authHandler) {
        const path = url.replace(PROJECT_URL, "");
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return authHandler(path, body);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(() => {
  // A distinct URL per test: supabase-auth.ts's own JWKS cache is keyed by URL and lives at module
  // scope, so a shared URL across tests would let one test's cached keys leak into another's.
  jwksUrl = `https://project.supabase.co/jwks/${randomUUID()}`;
  jwksKeys = [jwk];
  authHandler = null;
  vi.stubEnv("SUPABASE_PROJECT_URL", PROJECT_URL);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  vi.stubEnv("SUPABASE_JWKS_URL", jwksUrl);
  stubFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("verifySupabaseAccessToken", () => {
  it("accepts a validly signed, current token and reads sub/email from the VERIFIED payload", async () => {
    const token = signToken(validPayload());
    await expect(verifySupabaseAccessToken(token)).resolves.toEqual({ userId: USER_ID, email: EMAIL });
  });

  it("rejects a tampered token — one flipped payload character invalidates the signature", async () => {
    const token = signToken(validPayload());
    const [h, p, s] = token.split(".");
    const flipped = p.slice(0, -1) + (p.at(-1) === "A" ? "B" : "A");
    await expect(verifySupabaseAccessToken(`${h}.${flipped}.${s}`)).resolves.toBeNull();
  });

  it("rejects the wrong issuer", async () => {
    const token = signToken(validPayload({ iss: "https://not-my-project.supabase.co/auth/v1" }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects the wrong audience", async () => {
    const token = signToken(validPayload({ aud: "anon" }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = signToken(validPayload({ exp: Math.floor(Date.now() / 1000) - 60 }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects an unknown kid, even after the one automatic refetch", async () => {
    const token = signToken(validPayload(), { kid: "some-other-key" });
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects a header alg that disagrees with the key's own kty (HS256 never matches an EC/RSA JWK)", async () => {
    const token = signToken(validPayload(), { alg: "HS256" });
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects an RS256 header against the JWKS's EC key — the algorithm is decided by the key's own kty, never trusted from the header", async () => {
    const token = signToken(validPayload(), { alg: "RS256" });
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects an HS256 token signed with a kty: oct JWK's own key — oct never reaches EC/RSA verification", async () => {
    const octSecret = randomBytes(32);
    const octKid = "oct-key";
    jwksKeys = [jwk, { kty: "oct", k: octSecret.toString("base64url"), kid: octKid }];
    const header = { alg: "HS256", kid: octKid, typ: "JWT" };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(validPayload()))}`;
    const signature = createHmac("sha256", octSecret).update(signingInput).digest();
    const token = `${signingInput}.${base64url(signature)}`;
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects alg: none outright", async () => {
    const token = signToken(validPayload(), { alg: "none" });
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects a malformed token (not three dot-separated parts) without throwing", async () => {
    await expect(verifySupabaseAccessToken("not-a-jwt")).resolves.toBeNull();
  });

  it("rejects a sub that isn't v4-shaped (wrong version nibble)", async () => {
    const notV4 = `${USER_ID.slice(0, 14)}1${USER_ID.slice(15)}`;
    const token = signToken(validPayload({ sub: notV4 }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects an upper-case sub even if otherwise v4-shaped", async () => {
    const token = signToken(validPayload({ sub: USER_ID.toUpperCase() }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects a token with no iat", async () => {
    const token = signToken(validPayload({ iat: undefined }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("rejects a token whose iat is in the future beyond the clock-skew tolerance", async () => {
    const token = signToken(validPayload({ iat: Math.floor(Date.now() / 1000) + 3600 }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("accepts a token whose iat is within the clock-skew tolerance of now", async () => {
    const token = signToken(validPayload({ iat: Math.floor(Date.now() / 1000) + 30 }));
    await expect(verifySupabaseAccessToken(token)).resolves.toEqual({ userId: USER_ID, email: EMAIL });
  });

  it("nbf is optional — a token without one is still accepted", async () => {
    const token = signToken(validPayload());
    await expect(verifySupabaseAccessToken(token)).resolves.toEqual({ userId: USER_ID, email: EMAIL });
  });

  it("honors nbf when present: rejects a token not yet valid", async () => {
    const token = signToken(validPayload({ nbf: Math.floor(Date.now() / 1000) + 3600 }));
    await expect(verifySupabaseAccessToken(token)).resolves.toBeNull();
  });

  it("accepts a token whose nbf is already in the past", async () => {
    const token = signToken(validPayload({ nbf: Math.floor(Date.now() / 1000) - 60 }));
    await expect(verifySupabaseAccessToken(token)).resolves.toEqual({ userId: USER_ID, email: EMAIL });
  });
});

describe("signIn", () => {
  it("returns the verified identity on success", async () => {
    authHandler = (path) => {
      expect(path).toBe("/auth/v1/token?grant_type=password");
      return jsonResponse(200, { access_token: signToken(validPayload()) });
    };
    await expect(signIn(EMAIL, PASSWORD)).resolves.toEqual({ userId: USER_ID, email: EMAIL });
  });

  it("maps a 400/401 to INVALID_CREDENTIALS — generic, never distinguishing wrong password from no account", async () => {
    authHandler = () => jsonResponse(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" });
    await expect(signIn(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("maps 429 to RATE_LIMITED", async () => {
    authHandler = () => jsonResponse(429, { error_code: "over_request_rate_limit" });
    await expect(signIn(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("maps a 5xx to UPSTREAM_UNAVAILABLE", async () => {
    authHandler = () => jsonResponse(500, { error: "internal" });
    await expect(signIn(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("maps a network failure to UPSTREAM_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(signIn(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("maps an abort/timeout to TIMEOUT", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));
    await expect(signIn(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("never logs or echoes the password or the token, on success or failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = signToken(validPayload());
    authHandler = () => jsonResponse(200, { access_token: token });
    await signIn(EMAIL, PASSWORD);

    authHandler = () => jsonResponse(400, { error_code: "invalid_credentials" });
    await expect(signIn(EMAIL, PASSWORD)).rejects.toBeInstanceOf(AppError);

    const allLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join("\n");
    expect(allLogged).not.toContain(PASSWORD);
    expect(allLogged).not.toContain(token);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("signUp", () => {
  it("returns the verified identity when Supabase returns a session immediately", async () => {
    authHandler = (path) => {
      expect(path).toBe("/auth/v1/signup");
      return jsonResponse(200, { user: { id: USER_ID }, session: { access_token: signToken(validPayload()) } });
    };
    await expect(signUp(EMAIL, PASSWORD)).resolves.toEqual({ userId: USER_ID, email: EMAIL });
  });

  it("throws EMAIL_CONFIRMATION_REQUIRED when Supabase creates the user but returns no session (email confirmation is on)", async () => {
    authHandler = () => jsonResponse(200, { user: { id: USER_ID }, session: null });
    await expect(signUp(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "EMAIL_CONFIRMATION_REQUIRED" });
  });

  it("maps an already-registered email to EMAIL_IN_USE", async () => {
    authHandler = () => jsonResponse(422, { error_code: "user_already_exists", msg: "User already registered" });
    await expect(signUp(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "EMAIL_IN_USE" });
  });

  it("maps 429 to RATE_LIMITED", async () => {
    authHandler = () => jsonResponse(429, { error_code: "over_request_rate_limit" });
    await expect(signUp(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("maps an unrecognised rejection to VALIDATION_FAILED, never echoing Supabase's own error body", async () => {
    authHandler = () => jsonResponse(422, { error_code: "weak_password", msg: "Password is too weak" });
    await expect(signUp(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
