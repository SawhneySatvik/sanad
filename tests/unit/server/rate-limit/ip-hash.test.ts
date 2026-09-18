import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/server/core/env";
import { hashIp } from "@/server/rate-limit/ip-hash";

const VALID_SECRET = "a".repeat(32);
const RAW_IP = "203.0.113.42";

beforeEach(() => {
  vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", VALID_SECRET);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("hashIp", () => {
  it("never returns the raw IP", () => {
    expect(hashIp(RAW_IP)).not.toBe(RAW_IP);
  });

  it("the raw IP never appears as a substring of the hashed value", () => {
    expect(hashIp(RAW_IP)).not.toContain(RAW_IP);
  });

  it("is stable for the same IP under the same secret", () => {
    expect(hashIp(RAW_IP)).toBe(hashIp(RAW_IP));
  });

  it("differs for different IPs", () => {
    expect(hashIp(RAW_IP)).not.toBe(hashIp("198.51.100.7"));
  });

  it("differs for different secrets — proves the hash is actually secret-keyed, not a bare digest", () => {
    const first = hashIp(RAW_IP);
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "b".repeat(32));
    expect(hashIp(RAW_IP)).not.toBe(first);
  });
});

describe("production secret enforcement (mirrors src/server/auth/session.ts's rules)", () => {
  it("throws a typed ConfigError when RATE_LIMIT_IP_HASH_SECRET is missing in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "");
    expect(() => hashIp(RAW_IP)).toThrow(ConfigError);
  });

  it("throws a typed ConfigError when the secret is exactly 1 byte short of the 32-byte floor", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "a".repeat(31));
    expect(() => hashIp(RAW_IP)).toThrow(ConfigError);
  });

  it("throws a typed ConfigError when the secret is whitespace-only in production, even though it's 32+ bytes long", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", " ".repeat(40));
    expect(() => hashIp(RAW_IP)).toThrow(ConfigError);
  });

  it("never includes the configured secret value in the thrown error's message", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "recognizable-short-marker");
    let caught: unknown;
    try {
      hashIp(RAW_IP);
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
      vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", secret);
      expect(() => hashIp(RAW_IP)).not.toThrow(/docs\//);
      expect(() => hashIp(RAW_IP)).toThrow(`RATE_LIMIT_IP_HASH_SECRET ${problem}.`);
      expect(() => hashIp(RAW_IP)).toThrow(/set it to a random value of at least 32 bytes/);
    }
  });

  it("succeeds in production with a valid 32+ byte secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "c".repeat(32));
    expect(() => hashIp(RAW_IP)).not.toThrow();
  });
});

describe("ephemeral secret fallback outside production", () => {
  it("logs the fallback warning exactly once across many calls, and never logs the secret value", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "recognizable-short-marker");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await import("@/server/rate-limit/ip-hash");

    fresh.hashIp(RAW_IP);
    fresh.hashIp("198.51.100.7");
    fresh.hashIp(RAW_IP);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls.flat().join(" ");
    expect(loggedText).not.toContain("recognizable-short-marker");
  });

  it("stays stable within the same process under the ephemeral fallback", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await import("@/server/rate-limit/ip-hash");

    expect(fresh.hashIp(RAW_IP)).toBe(fresh.hashIp(RAW_IP));
  });

  it("uses a different ephemeral secret per process — a hash from one fresh module instance differs from another", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.resetModules();
    const moduleA = await import("@/server/rate-limit/ip-hash");
    const hashA = moduleA.hashIp(RAW_IP);

    vi.resetModules();
    const moduleB = await import("@/server/rate-limit/ip-hash");
    const hashB = moduleB.hashIp(RAW_IP);

    expect(hashA).not.toBe(hashB);
  });
});
