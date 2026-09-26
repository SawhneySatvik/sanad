import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportNetworkFailure, useIsOffline } from "@/lib/api/offline-status";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useIsOffline", () => {
  it("reports false when navigator.onLine is true and nothing has failed", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { result } = renderHook(() => useIsOffline());
    expect(result.current).toBe(false);
  });

  it("reports true when navigator.onLine is false", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { result } = renderHook(() => useIsOffline());
    expect(result.current).toBe(true);
  });

  it("flips true when the window fires its own offline event, without navigator.onLine changing first", () => {
    const nav = { onLine: true };
    vi.stubGlobal("navigator", nav);
    const { result } = renderHook(() => useIsOffline());
    expect(result.current).toBe(false);

    act(() => {
      nav.onLine = false;
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(true);
  });

  it("reportNetworkFailure() flips it true even while navigator.onLine stays true, then decays after 15s", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    const { result } = renderHook(() => useIsOffline());
    expect(result.current).toBe(false);

    act(() => reportNetworkFailure());
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(14_999));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it("a real online event clears a failure reported during the outage, without waiting out the decay", () => {
    vi.useFakeTimers();
    const nav = { onLine: false };
    vi.stubGlobal("navigator", nav);
    const { result } = renderHook(() => useIsOffline());

    act(() => reportNetworkFailure());
    expect(result.current).toBe(true);

    act(() => {
      nav.onLine = true;
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current).toBe(false);
  });

  it("a second reportNetworkFailure() restarts the decay window rather than letting the first timer clear it early", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    const { result } = renderHook(() => useIsOffline());

    act(() => reportNetworkFailure());
    act(() => vi.advanceTimersByTime(10_000));
    act(() => reportNetworkFailure());
    act(() => vi.advanceTimersByTime(10_000)); // 20s since the first call, but only 10s since the second
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(5_000)); // 15s since the second call
    expect(result.current).toBe(false);
  });
});
