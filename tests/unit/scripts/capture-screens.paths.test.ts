import path from "node:path";
import { describe, expect, it } from "vitest";
import { screenshotPath, THEMES, VIEWPORTS } from "../../e2e/support/capture/paths";

describe("screenshotPath", () => {
  it("names a file <outDir>/<screen>/<state>-<viewport>-<theme>.png", () => {
    expect(screenshotPath("/out", "workspace", "default", "desktop", "light")).toBe(path.join("/out", "workspace", "default-desktop-light.png"));
    expect(screenshotPath("/out", "workspace", "loading", "phone", "dark")).toBe(path.join("/out", "workspace", "loading-phone-dark.png"));
  });
});

describe("VIEWPORTS", () => {
  it("matches playwright.config.ts's own desktop and phone projects", () => {
    expect(VIEWPORTS).toEqual([
      { name: "desktop", width: 1440, height: 900, isMobile: false },
      { name: "phone", width: 390, height: 844, isMobile: true },
    ]);
  });
});

describe("THEMES", () => {
  it("is light and dark, in that order", () => {
    expect(THEMES).toEqual(["light", "dark"]);
  });
});
