import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUploadFlow } from "@/components/upload/use-upload-flow";
import { MAX_UPLOAD_SIZE_BYTES } from "@/components/upload/constants";

function fileOf(name: string, sizeBytes: number, type: string): File {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const DOC_ID = "0a0a0a0a-0000-4000-8000-00000000000a";

function analyzeOutput(id: string) {
  return {
    analysisState: "complete",
    document: {
      id,
      title: "lease.pdf",
      sampleId: null,
      projectId: null,
      filename: "lease.pdf",
      mimeType: "application/pdf",
      processingStatus: "ready",
      inputMode: "text",
      documentType: "leave_and_license",
      jurisdiction: "IN",
      detectionConfidence: "0.9",
      uploadedAt: "2026-09-23T10:00:00.000Z",
      expiresAt: null,
    },
    analysis: { id: "0b0b0b0b-0000-4000-8000-00000000000b", promptVersion: "v1", modelUsed: "gemini-2.5-flash", createdAt: "2026-09-23T10:00:00.000Z" },
    findings: [],
  };
}

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
    /* the test drives completion explicitly via resolve()/networkError()/abort() below */
  }
  abort() {
    this.onabort?.();
  }
  getResponseHeader(name: string): string | null {
    return this.headers[name.toLowerCase()] ?? null;
  }
  resolve(status: number, body?: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = body !== undefined ? JSON.stringify(body) : "";
    this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.onload?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  networkError() {
    this.onerror?.();
  }
}

function wrapper() {
  const queryClient = new QueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { Wrapper, queryClient };
}

function stubFakeXhr() {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useUploadFlow — the happy path", () => {
  it("runs POST /api/uploads -> PUT -> POST /api/documents and calls onUploaded, pre-warming the cache", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/uploads") return jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" });
      if (url === "/api/documents") return jsonResponse(200, analyzeOutput(DOC_ID));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const onUploaded = vi.fn();
    const { Wrapper, queryClient } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    expect(result.current.phase).toBe("uploading");

    act(() => FakeXHR.instances[0].resolve(200, { ref: "ref-1" }));

    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(onUploaded).toHaveBeenCalledWith(DOC_ID);
    expect(queryClient.getQueryData(["documents", DOC_ID])).toEqual(analyzeOutput(DOC_ID));
  });

  it("follows the returned method/uploadUrl literally, never a hard-coded relay path", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/uploads") return jsonResponse(200, { method: "direct-put", uploadUrl: "https://storage.example/mock-direct-put", ref: "ref-2" });
        if (url === "/api/documents") return jsonResponse(200, analyzeOutput(DOC_ID));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    expect(FakeXHR.instances[0].url).toBe("https://storage.example/mock-direct-put");
  });

  it("percent tracks real XMLHttpRequest.upload.onprogress values", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/uploads") return jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" });
        return jsonResponse(200, analyzeOutput(DOC_ID));
      }),
    );

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));

    act(() => FakeXHR.instances[0].progress(50, 100));
    await waitFor(() => expect(result.current.percent).toBe(50));

    act(() => FakeXHR.instances[0].progress(100, 100));
    await waitFor(() => expect(result.current.percent).toBe(100));
  });
});

describe("useUploadFlow — client pre-checks (no request fires)", () => {
  it("a zero-byte file never calls fetch and reports the empty reason", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("empty.pdf", 0, "application/pdf")));

    expect(result.current.phase).toBe("error");
    expect(result.current.error).toEqual({ code: "CLIENT_REJECTED", reason: "empty" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an oversized file never calls fetch and reports too_large", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("big.pdf", MAX_UPLOAD_SIZE_BYTES + 1, "application/pdf")));

    expect(result.current.error?.reason).toBe("too_large");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("useUploadFlow — offline", () => {
  it("navigator.onLine === false never attempts POST /api/uploads", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));

    // The offline check happens inside the async network step, one microtask after start()
    // returns — the phase passes through "requesting-target" first, same as any real attempt.
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.code).toBe("OFFLINE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("useUploadFlow — PUT-phase failures", () => {
  it("a mid-transfer network drop produces UPLOAD_INTERRUPTED, no documentId, no retry handle", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" })),
    );

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));

    act(() => FakeXHR.instances[0].networkError());

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toEqual({ code: "UPLOAD_INTERRUPTED" });
  });

  it("a 422 empty (zero bytes actually written) surfaces the reason, no documentId", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" })),
    );

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));

    act(() => FakeXHR.instances[0].resolve(422, { error: { code: "INVALID_DOCUMENT", message: "x", reason: "empty" } }));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toMatchObject({ code: "INVALID_DOCUMENT", reason: "empty" });
    expect(result.current.error?.documentId).toBeUndefined();
  });
});

describe("useUploadFlow — retry-by-documentId (F6.2)", () => {
  it("a 503 on confirm carries documentId; retry() succeeds through POST /api/documents/:id/analyze", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "/api/uploads") return jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" });
        if (url === "/api/documents") {
          return jsonResponse(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "busy", documentId: DOC_ID, retryAfterSeconds: 5 } });
        }
        if (url === `/api/documents/${DOC_ID}/analyze`) return jsonResponse(200, analyzeOutput(DOC_ID));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const onUploaded = vi.fn();
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    act(() => FakeXHR.instances[0].resolve(200, { ref: "ref-1" }));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", documentId: DOC_ID, retryAfterSeconds: 5 });

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(onUploaded).toHaveBeenCalledWith(DOC_ID);
    expect(calls).toEqual(["/api/uploads", "/api/documents", `/api/documents/${DOC_ID}/analyze`]);
  });
});

describe("useUploadFlow — retry() guards against an unmounted host", () => {
  it("retryAnalyze resolving after the host unmounts never calls onUploaded — a stale retry must never navigate", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    let resolveAnalyze: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/uploads") return jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" });
        if (url === "/api/documents") {
          return jsonResponse(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "busy", documentId: DOC_ID } });
        }
        if (url === `/api/documents/${DOC_ID}/analyze`) return new Promise<Response>((resolve) => (resolveAnalyze = resolve));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const onUploaded = vi.fn();
    const { Wrapper } = wrapper();
    const { result, unmount } = renderHook(() => useUploadFlow({ onUploaded }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    act(() => FakeXHR.instances[0].resolve(200, { ref: "ref-1" }));
    await waitFor(() => expect(result.current.error?.documentId).toBe(DOC_ID));

    act(() => result.current.retry());
    unmount();

    resolveAnalyze(jsonResponse(200, analyzeOutput(DOC_ID)));
    await new Promise((r) => setTimeout(r, 0));
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe("useUploadFlow — cancel", () => {
  it("cancels the in-flight PUT and returns to idle", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" })),
    );

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(result.current.phase).toBe("uploading"));

    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.phase).toBe("idle"));
  });

  it("is a no-op outside the uploading phase (e.g. while confirming)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/uploads") return jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" });
        // Never resolves during this test, keeping the flow parked in "confirming".
        return new Promise<Response>(() => {});
      }),
    );

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));
    act(() => FakeXHR.instances[0].resolve(200, { ref: "ref-1" }));
    await waitFor(() => expect(result.current.phase).toBe("confirming"));

    act(() => result.current.cancel());
    expect(result.current.phase).toBe("confirming");
  });
});

describe("useUploadFlow — busy", () => {
  it("is true through every network phase and false at idle/done/error", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    stubFakeXhr();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/uploads") return jsonResponse(200, { method: "server-relay", uploadUrl: "/api/uploads/relay?token=t1", ref: "ref-1" });
        return jsonResponse(200, analyzeOutput(DOC_ID));
      }),
    );

    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUploadFlow({ onUploaded: vi.fn() }), { wrapper: Wrapper });
    expect(result.current.busy).toBe(false);

    act(() => result.current.start(fileOf("lease.pdf", 1000, "application/pdf")));
    await waitFor(() => expect(result.current.phase).toBe("uploading"));
    expect(result.current.busy).toBe(true);

    act(() => FakeXHR.instances[0].resolve(200, { ref: "ref-1" }));
    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.busy).toBe(false);
  });
});
