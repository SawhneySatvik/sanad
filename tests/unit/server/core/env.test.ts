import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, optionalEnv, requireEnv } from "@/server/core/env";

// Invented, project-specific names — real provider keys (GEMINI_API_KEY etc.)
// are deleted by tests/setup/no-network.ts, so using one of those here would
// prove nothing either way.
const PRESENT_VAR = "T100_TEST_ENV_PRESENT_VAR";
const MISSING_VAR = "T100_TEST_ENV_MISSING_VAR";

afterEach(() => {
  delete process.env[PRESENT_VAR];
  delete process.env[MISSING_VAR];
});

describe("requireEnv", () => {
  it("returns the value when the variable is set", () => {
    process.env[PRESENT_VAR] = "hello";
    expect(requireEnv(PRESENT_VAR)).toBe("hello");
  });

  it("throws a ConfigError naming the missing variable when unset", () => {
    expect(() => requireEnv(MISSING_VAR)).toThrow(ConfigError);

    let caught: unknown;
    try {
      requireEnv(MISSING_VAR);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).variableName).toBe(MISSING_VAR);
    expect((caught as ConfigError).message).toContain(MISSING_VAR);
  });

  it("treats an empty string as missing", () => {
    process.env[PRESENT_VAR] = "";
    expect(() => requireEnv(PRESENT_VAR)).toThrow(ConfigError);
  });

  it("reads lazily — a variable set AFTER this module was imported is still seen", () => {
    // `requireEnv`/`optionalEnv` are already imported at the top of this
    // file; setting the var only now (inside the test body) and having it
    // read correctly proves env.ts does not cache/snapshot at import time.
    expect(process.env[PRESENT_VAR]).toBeUndefined();
    process.env[PRESENT_VAR] = "set-after-import";
    expect(requireEnv(PRESENT_VAR)).toBe("set-after-import");
  });
});

describe("optionalEnv", () => {
  it("returns the value when set", () => {
    process.env[PRESENT_VAR] = "value";
    expect(optionalEnv(PRESENT_VAR)).toBe("value");
  });

  it("returns undefined when unset, never throws", () => {
    expect(optionalEnv(MISSING_VAR)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    process.env[PRESENT_VAR] = "";
    expect(optionalEnv(PRESENT_VAR)).toBeUndefined();
  });
});
