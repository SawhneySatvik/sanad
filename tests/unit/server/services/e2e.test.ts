import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/core/errors";
import { forceThrow, ping } from "@/server/services/e2e";
import { HealthOutput } from "@/shared/contracts/health";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubNonProduction(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL", "");
}

describe("forceThrow", () => {
  it("throws a NOT_FOUND AppError when SABOOT_E2E isn't set", async () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "");

    let caught: unknown;
    try {
      await forceThrow();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("throws a plain Error (not an AppError) when SABOOT_E2E=1 outside production", async () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "1");

    let caught: unknown;
    try {
      await forceThrow();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AppError);
  });

  it("in production, SABOOT_E2E unset never throws anything but NOT_FOUND", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "");

    let caught: unknown;
    try {
      await forceThrow();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("in production, SABOOT_E2E=1 is refused (isE2eMode()'s own guard), never reaches the deliberate throw", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");

    await expect(forceThrow()).rejects.toThrow("must never be set in production");
  });
});

describe("ping", () => {
  it("throws a NOT_FOUND AppError when SABOOT_E2E isn't set", async () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "");

    let caught: unknown;
    try {
      await ping();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("returns the exact HealthOutput contract shape when SABOOT_E2E=1 outside production", async () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "1");

    const result = await ping();

    // HealthOutput.parse() pins the field names and types against the shared contract (an
    // independent source from e2e.ts's own object literal — ping() would fail this test if it
    // dropped a field or changed a type). The literal true/true/"ok" values below match what
    // ping() always returns for a healthy harness; there's no separate spec for those particular
    // booleans beyond the code itself, so this half of the assertion is a regression pin, not an
    // independent-source check.
    expect(HealthOutput.parse(result)).toEqual({ status: "ok", config: { llm: true, storage: true } });
  });

  it("in production, SABOOT_E2E unset never returns anything but a NOT_FOUND throw", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "");

    let caught: unknown;
    try {
      await ping();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("in production, SABOOT_E2E=1 is refused (isE2eMode()'s own guard), never resolves 200", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");

    await expect(ping()).rejects.toThrow("must never be set in production");
  });
});
