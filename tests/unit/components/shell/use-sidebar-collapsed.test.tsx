import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const STORAGE_KEY = "saboot:sidebar-collapsed:v1";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});
afterEach(() => {
  window.localStorage.clear();
});

describe("useSidebarCollapsed", () => {
  it("reads and persists through localStorage when storage works", async () => {
    const { useSidebarCollapsed } = await import("@/components/shell/use-sidebar-collapsed");
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("still toggles in memory when localStorage throws on every call — never stuck reporting false", async () => {
    const { useSidebarCollapsed } = await import("@/components/shell/use-sidebar-collapsed");
    const getItem = vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new DOMException("disabled", "SecurityError");
    });
    const setItem = vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
      throw new DOMException("disabled", "SecurityError");
    });

    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](true));
    // Without the in-memory fallback, getSnapshot re-throws on every read and this stays false
    // forever — collapse would silently do nothing whenever storage is disabled.
    expect(result.current[0]).toBe(true);

    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
