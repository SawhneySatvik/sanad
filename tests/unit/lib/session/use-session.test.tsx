import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { sessionSignInAvailable, useSession } from "@/lib/session/use-session";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSession", () => {
  it("fetches GET /api/session under the ['session'] query key", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { kind: "guest", signInAvailable: true, guestTtlHours: 3 }));
    vi.stubGlobal("fetch", fetchSpy);

    const queryClient = new QueryClient();
    const { result } = renderHook(() => useSession(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
    expect(fetchSpy).toHaveBeenCalledWith("/api/session", expect.anything());
    expect(queryClient.getQueryState(["session"])?.dataUpdatedAt).toBeGreaterThan(0);
  });
});

describe("sessionSignInAvailable", () => {
  it("treats a failed session fetch as signInAvailable: false rather than propagating undefined", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "x" } })));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSession(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(sessionSignInAvailable(result.current)).toBe(false);
  });

  it("reads the real value once the session query succeeds", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { kind: "guest", signInAvailable: true, guestTtlHours: 3 })));

    const queryClient = new QueryClient();
    const { result } = renderHook(() => useSession(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sessionSignInAvailable(result.current)).toBe(true);
  });
});
