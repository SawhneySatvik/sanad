import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SESSION_BROADCAST_CHANNEL, notifySessionChanged, onSessionBroadcast, subscribeToSessionBroadcast } from "@/lib/session/sync";
import { useSession } from "@/lib/session/use-session";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const FAKE_SESSION = { kind: "guest", signInAvailable: true, guestTtlHours: 3 };

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

// resetQueries() only refetches an ACTIVE query — one with a mounted observer. In the real app,
// AppSidebar's own useSession() is always active, which a bare QueryClient-only test can't
// reproduce. Mounting the real hook here matches that condition.
function mountSessionObserver(queryClient: QueryClient) {
  return renderHook(() => useSession(), { wrapper: wrapper(queryClient) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifySessionChanged", () => {
  it("resets every cached query — including one with no mounted observer — back to its initial state immediately", () => {
    // Not queryClient.clear(): clear() destroys every Query object outright, and a
    // currently-mounted observer (useSession(), or a list query RecentsList reads) does not
    // reliably resubscribe to a brand-new Query that reappears under the same key later —
    // confirmed against a real e2e run, where the cache held the correct fresh guest data (read
    // back immediately after a manual setQueryData) while the sidebar kept rendering the previous
    // principal's stale signed-in button and stale Recents rows regardless. resetQueries() resets
    // every Query *in place*, which a still-mounted observer reliably reacts to.
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    const queryClient = new QueryClient();
    queryClient.setQueryData(["documents", "list"], { items: [{ id: "doc-1" }], nextCursor: null });

    notifySessionChanged(queryClient);

    // Synchronous: even a query nothing currently observes goes back to "no data" immediately,
    // never left holding a previous principal's row past this call.
    expect(queryClient.getQueryData(["documents", "list"])).toBeUndefined();
  });

  it("refetches a currently-mounted ['session'] observer with the fresh value", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    const queryClient = new QueryClient();
    mountSessionObserver(queryClient);
    await waitFor(() => expect(queryClient.getQueryState(["session"])?.status).toBe("success"));

    notifySessionChanged(queryClient);

    await waitFor(() => expect(queryClient.getQueryData(["session"])).toEqual(FAKE_SESSION));
  });

  it("posts on BroadcastChannel(\"saboot:session\") when available, then closes it", () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    const postMessage = vi.fn();
    const close = vi.fn();
    const channels: string[] = [];
    class FakeBroadcastChannel {
      constructor(name: string) {
        channels.push(name);
      }
      postMessage = postMessage;
      close = close;
    }
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

    notifySessionChanged(new QueryClient());

    expect(channels).toEqual([SESSION_BROADCAST_CHANNEL]);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("falls back to a localStorage write when BroadcastChannel is unavailable", () => {
    // jsdom's Storage methods aren't spy-able (non-configurable instance properties) — reading the
    // real stored value back is the reliable assertion here, not vi.spyOn.
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    vi.stubGlobal("BroadcastChannel", undefined);
    window.localStorage.removeItem("saboot:session-broadcast");

    notifySessionChanged(new QueryClient());

    expect(window.localStorage.getItem("saboot:session-broadcast")).not.toBeNull();
  });
});

describe("subscribeToSessionBroadcast", () => {
  let originalBroadcastChannel: typeof BroadcastChannel | undefined;
  beforeEach(() => {
    originalBroadcastChannel = window.BroadcastChannel;
  });
  afterEach(() => {
    window.BroadcastChannel = originalBroadcastChannel as typeof BroadcastChannel;
  });

  it("resets every query and refetches the mounted session observer when another tab's channel message arrives", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    const instances: FakeBroadcastChannel[] = [];
    class FakeBroadcastChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

    const queryClient = new QueryClient();
    queryClient.setQueryData(["documents", "list"], { items: [{ id: "doc-1" }], nextCursor: null });
    mountSessionObserver(queryClient);
    await waitFor(() => expect(queryClient.getQueryState(["session"])?.status).toBe("success"));
    const unsubscribe = subscribeToSessionBroadcast(queryClient);

    const [instance] = instances;
    expect(instance).toBeDefined();
    instance.onmessage?.(new MessageEvent("message", { data: { type: "session-changed" } }));
    expect(queryClient.getQueryData(["documents", "list"])).toBeUndefined();
    await waitFor(() => expect(queryClient.getQueryData(["session"])).toEqual(FAKE_SESSION));

    unsubscribe();
  });

  it("falls back to the storage event when BroadcastChannel is unavailable, ignoring unrelated keys", () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    vi.stubGlobal("BroadcastChannel", undefined);
    const queryClient = new QueryClient();
    queryClient.setQueryData(["documents", "list"], { items: [{ id: "doc-1" }], nextCursor: null });
    const unsubscribe = subscribeToSessionBroadcast(queryClient);

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated-key" }));
    expect(queryClient.getQueryData(["documents", "list"])).toEqual({ items: [{ id: "doc-1" }], nextCursor: null });

    window.dispatchEvent(new StorageEvent("storage", { key: "saboot:session-broadcast" }));
    expect(queryClient.getQueryData(["documents", "list"])).toBeUndefined();

    unsubscribe();
  });

  it("notifies every onSessionBroadcast() listener when another tab's channel message arrives — the hook local-threads.ts registers into, without this module importing it", () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    const instances: FakeBroadcastChannel[] = [];
    class FakeBroadcastChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const listener = vi.fn();
    const unregister = onSessionBroadcast(listener);
    const unsubscribe = subscribeToSessionBroadcast(new QueryClient());

    const [instance] = instances;
    instance.onmessage?.(new MessageEvent("message", { data: { type: "session-changed" } }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    unregister();
  });

  it("notifies every onSessionBroadcast() listener via the storage-event fallback too", () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    vi.stubGlobal("BroadcastChannel", undefined);
    const listener = vi.fn();
    const unregister = onSessionBroadcast(listener);
    const unsubscribe = subscribeToSessionBroadcast(new QueryClient());

    window.dispatchEvent(new StorageEvent("storage", { key: "saboot:session-broadcast" }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    unregister();
  });

  it("never notifies onSessionBroadcast() listeners from notifySessionChanged's own same-tab call — only a listening tab's broadcast/storage-event path does", () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_SESSION)));
    const listener = vi.fn();
    const unregister = onSessionBroadcast(listener);

    notifySessionChanged(new QueryClient());
    expect(listener).not.toHaveBeenCalled();

    unregister();
  });
});
