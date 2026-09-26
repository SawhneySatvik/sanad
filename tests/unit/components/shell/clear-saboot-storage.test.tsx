import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSabootLocalStorage } from "@/components/shell/clear-saboot-storage";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("clearSabootLocalStorage", () => {
  it("removes every saboot:-prefixed key", () => {
    window.localStorage.setItem("saboot:threads:v1:index", "[]");
    window.localStorage.setItem("saboot:threads:v1:local-a", "{}");
    window.localStorage.setItem("saboot:situation:v1", "tenant");
    window.localStorage.setItem("saboot:sidebar-collapsed:v1", "true");
    window.localStorage.setItem("saboot:layout:workspace-split", "[300,400]");

    clearSabootLocalStorage();

    for (let i = 0; i < window.localStorage.length; i++) {
      expect(window.localStorage.key(i)).not.toMatch(/^saboot:/);
    }
  });

  it("never touches next-themes' own key", () => {
    window.localStorage.setItem("theme", "dark");
    window.localStorage.setItem("saboot:situation:v1", "tenant");

    clearSabootLocalStorage();

    expect(window.localStorage.getItem("theme")).toBe("dark");
    expect(window.localStorage.getItem("saboot:situation:v1")).toBeNull();
  });

  it("is a no-op on an empty store", () => {
    expect(() => clearSabootLocalStorage()).not.toThrow();
  });
});
