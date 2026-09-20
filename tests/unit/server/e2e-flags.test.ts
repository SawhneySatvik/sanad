// The e2e harness's production refusal: SABOOT_E2E=1 must never take effect in a production
// process, whatever else is set alongside it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/server/core/env";
import { isE2eMode } from "@/server/core/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isE2eMode", () => {
  it("is false when SABOOT_E2E is unset, whatever NODE_ENV is", () => {
    vi.stubEnv("SABOOT_E2E", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    expect(isE2eMode()).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    expect(isE2eMode()).toBe(false);
  });

  it("is true outside production when SABOOT_E2E=1", () => {
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    expect(isE2eMode()).toBe(true);

    vi.stubEnv("NODE_ENV", "test");
    expect(isE2eMode()).toBe(true);
  });

  it("treats any value but the literal \"1\" as off", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    for (const value of ["true", "yes", "0", " 1", "1 "]) {
      vi.stubEnv("SABOOT_E2E", value);
      expect(isE2eMode(), value).toBe(false);
    }
  });

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production", VERCEL: "" }],
    ["VERCEL=1 whatever NODE_ENV says", { NODE_ENV: "test", VERCEL: "1" }],
  ])("refuses SABOOT_E2E=1 in production (%s)", (_label, env) => {
    vi.stubEnv("SABOOT_E2E", "1");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    let caught: unknown;
    try {
      isE2eMode();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).variableName).toBe("SABOOT_E2E");
    expect((caught as Error).message).toContain("must never be set in production");
  });

  it("a production process with the flag unset never throws (positive control)", () => {
    vi.stubEnv("SABOOT_E2E", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    expect(() => isE2eMode()).not.toThrow();
    expect(isE2eMode()).toBe(false);
  });
});
