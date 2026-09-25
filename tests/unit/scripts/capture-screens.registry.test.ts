import { describe, expect, it } from "vitest";
import { isValidScreenName, loadStateRegistry, pickStates } from "../../e2e/support/capture/registry";

describe("isValidScreenName", () => {
  it("accepts letters, digits, dashes and underscores", () => {
    expect(isValidScreenName("shell")).toBe(true);
    expect(isValidScreenName("smoke")).toBe(true);
    expect(isValidScreenName("project-detail")).toBe(true);
  });

  it("rejects a path-traversal attempt or any path separator", () => {
    expect(isValidScreenName("../../etc/passwd")).toBe(false);
    expect(isValidScreenName("shell/../secret")).toBe(false);
    expect(isValidScreenName("")).toBe(false);
  });
});

describe("loadStateRegistry", () => {
  it("loads this screen's real registered file (the harness's own smoke fixture)", async () => {
    const registry = await loadStateRegistry("smoke");
    expect(Object.keys(registry).sort()).toEqual(["broken", "default", "external"]);
    expect(registry.default.route).toBe("/");
  });

  it("rejects an invalid screen name before ever touching the filesystem", async () => {
    await expect(loadStateRegistry("../nope")).rejects.toThrow(/not a valid screen name/);
  });

  it("names the missing file for a well-formed but unregistered screen", async () => {
    await expect(loadStateRegistry("does-not-exist")).rejects.toThrow(
      /no state registry at tests\/e2e\/support\/capture\/states\/does-not-exist\.ts/,
    );
  });
});

describe("pickStates", () => {
  it("returns the named states, in the order given", async () => {
    const registry = await loadStateRegistry("smoke");
    const selected = pickStates(registry, ["broken", "default"]);
    expect(selected.map((s) => s.name)).toEqual(["broken", "default"]);
    expect(selected[1].state.route).toBe("/");
  });

  it("lists what IS available when a name doesn't match", async () => {
    const registry = await loadStateRegistry("smoke");
    expect(() => pickStates(registry, ["nope"])).toThrow(/available: default, broken, external/);
  });
});
