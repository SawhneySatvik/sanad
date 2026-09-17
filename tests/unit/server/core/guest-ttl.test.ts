import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GUEST_DATA_TTL_SECONDS, guestDataTtlSeconds } from "@/server/core/guest-ttl";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubNonProduction(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL", "");
}

describe("guestDataTtlSeconds", () => {
  it("is the 3-hour default outside the e2e harness", () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "");
    vi.stubEnv("SABOOT_E2E_GUEST_TTL_SECONDS", "5");
    expect(guestDataTtlSeconds()).toBe(DEFAULT_GUEST_DATA_TTL_SECONDS);
    expect(DEFAULT_GUEST_DATA_TTL_SECONDS).toBe(3 * 60 * 60);
  });

  it("honours the override inside the e2e harness", () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_GUEST_TTL_SECONDS", "7");
    expect(guestDataTtlSeconds()).toBe(7);
  });

  it("falls back to the default when the override is unset even inside the harness", () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_GUEST_TTL_SECONDS", "");
    expect(guestDataTtlSeconds()).toBe(DEFAULT_GUEST_DATA_TTL_SECONDS);
  });

  it("falls back to the default on a non-positive-integer override, without throwing", () => {
    stubNonProduction();
    vi.stubEnv("SABOOT_E2E", "1");
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["0", "-1", "1.5", "abc", "1e9"]) {
      vi.stubEnv("SABOOT_E2E_GUEST_TTL_SECONDS", bad);
      expect(guestDataTtlSeconds(), bad).toBe(DEFAULT_GUEST_DATA_TTL_SECONDS);
    }
    logged.mockRestore();
  });

  it("production ignores the override — isE2eMode()'s own refusal makes it always the default", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    // SABOOT_E2E is never set to "1" here: a real production process would never have it set at
    // all, so this proves the ordinary (unset-flag) production path, never isE2eMode()'s throw.
    vi.stubEnv("SABOOT_E2E", "");
    vi.stubEnv("SABOOT_E2E_GUEST_TTL_SECONDS", "9");
    expect(guestDataTtlSeconds()).toBe(DEFAULT_GUEST_DATA_TTL_SECONDS);
  });

  it("production with SABOOT_E2E=1 throws (isE2eMode()'s own guard), never silently applies the override", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_GUEST_TTL_SECONDS", "9");
    expect(() => guestDataTtlSeconds()).toThrow("must never be set in production");
  });
});
