// @vitest-environment jsdom
//
// putRelay's own XMLHttpRequest path — the one piece of this flow apiFetch can't cover, since it's
// XHR, not fetch(). createUploadTarget/confirmAnalyze/retryAnalyze are thin apiFetchJson wrappers
// already covered end to end through useUploadFlow's own tests; this file is putRelay's.
//
// Each reportNetworkFailure test resets the module registry and re-imports both this module and
// @/lib/api fresh — offline-status.ts's "recently failed" flag is a real module-level singleton, so
// running the direct-put and server-relay cases against the SAME instance would let one contaminate
// the other's assertion.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/** A minimal, test-only XMLHttpRequest double — no real jsdom XHR/network involved. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  method = "";
  url = "";
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send() {
    /* the test drives completion explicitly */
  }
  abort() {
    this.onabort?.();
  }
  getResponseHeader(name: string): string | null {
    return this.headers[name.toLowerCase()] ?? null;
  }
  resolve(status: number, bodyText = "", headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = bodyText;
    this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.onload?.();
  }
  networkError() {
    this.onerror?.();
  }
}

function stubFakeXhr() {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("putRelay — reportNetworkFailure gating (direct-put vs server-relay)", () => {
  it("a server-relay xhr.onerror DOES raise the app-wide offline signal — a same-origin failure is a real connectivity signal", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    const { putRelay } = await import("@/components/upload/api");
    const { useIsOffline } = await import("@/lib/api");

    const offline = renderHook(() => useIsOffline());
    expect(offline.result.current).toBe(false);

    const pending = putRelay({ method: "server-relay", uploadUrl: "/api/uploads/relay?token=t" }, new File(["x"], "a.pdf"), () => {});
    pending.catch(() => undefined);
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));

    FakeXHR.instances[0].networkError();
    await waitFor(() => expect(offline.result.current).toBe(true));
  });

  it("a direct-put xhr.onerror never raises the offline signal — a storage-provider failure is not our own connection dropping", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    const { putRelay } = await import("@/components/upload/api");
    const { useIsOffline } = await import("@/lib/api");

    const offline = renderHook(() => useIsOffline());
    expect(offline.result.current).toBe(false);

    const pending = putRelay({ method: "direct-put", uploadUrl: "https://storage.example/mock" }, new File(["x"], "a.pdf"), () => {});
    const rejection = pending.catch((err: unknown) => err);
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));

    FakeXHR.instances[0].networkError();
    const err = await rejection;
    expect((err as { code: string }).code).toBe("UPLOAD_INTERRUPTED");
    expect(offline.result.current).toBe(false);
  });
});

describe("putRelay — error shapes", () => {
  it("xhr.onerror rejects with UploadInterruptedError, never ApiError (there is no HTTP status to carry)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    const { putRelay, UploadInterruptedError } = await import("@/components/upload/api");

    const pending = putRelay({ method: "server-relay", uploadUrl: "/api/uploads/relay?token=t" }, new File(["x"], "a.pdf"), () => {});
    const rejection = pending.catch((err: unknown) => err);
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0].networkError();

    expect(await rejection).toBeInstanceOf(UploadInterruptedError);
  });

  it("a non-2xx onload carries documentId through errorFromParts, exactly like apiFetch's own error shape", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    const { putRelay } = await import("@/components/upload/api");
    const { ApiError } = await import("@/lib/api");

    const pending = putRelay({ method: "server-relay", uploadUrl: "/api/uploads/relay?token=t" }, new File(["x"], "a.pdf"), () => {});
    const rejection = pending.catch((err: unknown) => err);
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    FakeXHR.instances[0].resolve(
      503,
      JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "busy", documentId: "0a0a0a0a-0000-4000-8000-00000000000a" } }),
    );

    const err = await rejection;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).documentId).toBe("0a0a0a0a-0000-4000-8000-00000000000a");
  });

  it("navigator.onLine === false rejects immediately with OFFLINE, never touching XMLHttpRequest at all", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    stubFakeXhr();
    const { putRelay } = await import("@/components/upload/api");
    const { ApiError } = await import("@/lib/api");

    await expect(putRelay({ method: "server-relay", uploadUrl: "/api/uploads/relay?token=t" }, new File(["x"], "a.pdf"), () => {})).rejects.toMatchObject(
      { code: "OFFLINE" },
    );
    expect(FakeXHR.instances).toHaveLength(0);
    expect(new ApiError({ code: "OFFLINE" }).code).toBe("OFFLINE"); // sanity: same error family, not a bespoke shape
  });
});
