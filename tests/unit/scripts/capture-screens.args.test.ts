import { describe, expect, it } from "vitest";
import { parseArgs } from "../../e2e/support/capture/args";

describe("parseArgs", () => {
  it("parses --screen and --states", () => {
    expect(parseArgs(["--screen", "workspace", "--states", "default,loading,error"])).toEqual({
      screen: "workspace",
      states: ["default", "loading", "error"],
      outDir: undefined,
    });
  });

  it("trims whitespace and drops empty entries in --states", () => {
    expect(parseArgs(["--screen", "workspace", "--states", " default , , error "])).toEqual({
      screen: "workspace",
      states: ["default", "error"],
      outDir: undefined,
    });
  });

  it("accepts an optional --out", () => {
    expect(parseArgs(["--screen", "workspace", "--states", "default", "--out", "/tmp/somewhere"])).toEqual({
      screen: "workspace",
      states: ["default"],
      outDir: "/tmp/somewhere",
    });
  });

  it("throws when --screen is missing", () => {
    expect(() => parseArgs(["--states", "default"])).toThrow(/--screen is required/);
  });

  it("throws when --screen is given an empty string", () => {
    expect(() => parseArgs(["--screen", "", "--states", "default"])).toThrow(/--screen is required/);
  });

  it("throws when --states is missing", () => {
    expect(() => parseArgs(["--screen", "workspace"])).toThrow(/--states is required/);
  });

  it("throws when --states resolves to an empty list", () => {
    expect(() => parseArgs(["--screen", "workspace", "--states", " , , "])).toThrow(/must list at least one state/);
  });

  it("throws on an unrecognised flag", () => {
    expect(() => parseArgs(["--screen", "workspace", "--states", "default", "--bogus", "x"])).toThrow(/unrecognised argument "--bogus"/);
  });
});
