import { describe, expect, it } from "vitest";
import { isThemeIdentical, isTooSmall, MIN_BYTES_BY_VIEWPORT } from "../../e2e/support/capture/capture-checks";

describe("isTooSmall", () => {
  it("flags a byte count under the floor", () => {
    expect(isTooSmall(1_999, 2_000)).toBe(true);
  });

  it("passes a byte count at or over the floor", () => {
    expect(isTooSmall(2_000, 2_000)).toBe(false);
    expect(isTooSmall(50_000, 2_000)).toBe(false);
  });
});

describe("isThemeIdentical", () => {
  it("flags byte-identical buffers (theme never applied)", () => {
    expect(isThemeIdentical(Buffer.from("same"), Buffer.from("same"))).toBe(true);
  });

  it("passes buffers that differ", () => {
    expect(isThemeIdentical(Buffer.from("light-bytes"), Buffer.from("dark--bytes"))).toBe(false);
  });

  it("treats different lengths as different", () => {
    expect(isThemeIdentical(Buffer.from("short"), Buffer.from("a bit longer"))).toBe(false);
  });
});

describe("MIN_BYTES_BY_VIEWPORT", () => {
  it("has a floor for both viewports, phone lower than desktop", () => {
    expect(MIN_BYTES_BY_VIEWPORT.desktop).toBeGreaterThan(MIN_BYTES_BY_VIEWPORT.phone);
    expect(MIN_BYTES_BY_VIEWPORT.phone).toBeGreaterThan(0);
  });
});
