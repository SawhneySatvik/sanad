import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiFetchJson, ApiError } from "@/lib/api/client";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch — offline detection", () => {
  it("throws an OFFLINE ApiError without calling fetch at all when navigator.onLine is false", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(apiFetch("/api/documents")).rejects.toMatchObject({ code: "OFFLINE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a fetch TypeError (a real transport failure) to an OFFLINE ApiError", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(apiFetch("/api/documents")).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch("/api/documents")).rejects.toMatchObject({ code: "OFFLINE" });
  });

  it("never relabels an AbortError as OFFLINE — it propagates untouched", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    await expect(apiFetch("/api/documents")).rejects.toBe(abortError);
  });

  it("rethrows any other kind of fetch rejection unchanged — not every failure is a network TypeError", async () => {
    const oddError = new RangeError("something else entirely");
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(oddError));

    await expect(apiFetch("/api/documents")).rejects.toBe(oddError);
  });
});

describe("apiFetch — successful responses", () => {
  it("returns the Response unchanged on a 2xx", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })));

    const response = await apiFetch("/api/documents");
    expect(response.status).toBe(200);
  });

  it("apiFetchJson parses the body", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { hello: "world" })));

    await expect(apiFetchJson<{ hello: string }>("/api/documents")).resolves.toEqual({ hello: "world" });
  });

  it("serializes `json` as the request body with a content-type header, and stays same-origin", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchSpy);

    await apiFetch("/api/documents", { method: "POST", json: { title: "Lease" } });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ title: "Lease" }));
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Headers).get("content-type")).toBe("application/json");
  });

  it("keeps a caller's own headers given as a Headers instance, not just a plain object", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchSpy);

    await apiFetch("/api/documents", { method: "POST", json: { a: 1 }, headers: new Headers({ "x-custom": "yes" }) });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("x-custom")).toBe("yes");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("keeps a caller's own headers given as a tuple array", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchSpy);

    await apiFetch("/api/documents", { headers: [["x-custom", "yes"]] });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get("x-custom")).toBe("yes");
  });
});

describe("apiFetch — error responses", () => {
  it("parses code/message/reason/retryAfterSeconds from the ErrorBody and the correlation id from the header", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          422,
          { error: { code: "INVALID_DOCUMENT", message: "The uploaded document could not be processed.", reason: "too_large" } },
          { "x-correlation-id": "corr-123" },
        ),
      ),
    );

    const err = await apiFetch("/api/documents").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.code).toBe("INVALID_DOCUMENT");
    expect(apiError.reason).toBe("too_large");
    expect(apiError.correlationId).toBe("corr-123");
    expect(apiError.message).toBe("The uploaded document could not be processed.");
  });

  it("carries the ErrorBody's own documentId (POST /api/documents failing after the document row already exists)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(503, {
          error: { code: "UPSTREAM_UNAVAILABLE", message: "busy", documentId: "0a0a0a0a-0000-4000-8000-00000000000a" },
        }),
      ),
    );

    const err = (await apiFetch("/api/documents").catch((e: unknown) => e)) as ApiError;
    expect(err.documentId).toBe("0a0a0a0a-0000-4000-8000-00000000000a");
  });

  it("leaves documentId undefined when the ErrorBody carries none", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(422, { error: { code: "INVALID_DOCUMENT", message: "x", reason: "empty" } })));

    const err = (await apiFetch("/api/documents").catch((e: unknown) => e)) as ApiError;
    expect(err.documentId).toBeUndefined();
  });

  it("prefers the body's retryAfterSeconds over the retry-after header when both are present", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(429, { error: { code: "RATE_LIMITED", message: "Too many requests.", retryAfterSeconds: 45 } }, { "retry-after": "999" }),
      ),
    );

    const err = (await apiFetch("/api/documents").catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterSeconds).toBe(45);
    expect(err.message).toBe("You've reached your limit for now. Try again in 45 seconds.");
  });

  it("falls back to the retry-after header when the body carries none (the streaming routes' case)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "busy" } }, { "retry-after": "120" })),
    );

    const err = (await apiFetch("/api/documents").catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterSeconds).toBe(120);
    expect(err.message).toBe("The AI providers are busy right now. Try again in 2 minutes.");
  });

  it("404 always renders the fixed sentence, matching the server's own NOT_FOUND message", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, { error: { code: "NOT_FOUND", message: "The requested resource could not be found." } })),
    );

    const err = (await apiFetch("/api/documents/x").catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe("The requested resource could not be found.");
  });

  it("falls back to a status-derived code when the body isn't a parseable ErrorBody at all", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 })));

    const err = (await apiFetch("/api/documents").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("SCHEMA_FAILED");
    // No serverMessage at all (an HTML body, not an ErrorBody) — message still falls back to the
    // canonical mirror, never the blank string a missing serverMessage used to produce.
    expect(err.message).toBe("The response from an upstream service was malformed.");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("falls all the way back to INTERNAL_ERROR when neither the body nor the status maps to a known code", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("I'm a teapot", { status: 418 })));

    const err = (await apiFetch("/api/documents").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("Something went wrong. Please try again.");
    expect(err.message.length).toBeGreaterThan(0);
  });
});
