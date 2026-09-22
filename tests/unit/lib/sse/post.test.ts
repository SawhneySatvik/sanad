import { afterEach, describe, expect, it, vi } from "vitest";
import { postSse } from "@/lib/sse/post";
import { ApiError } from "@/lib/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(frames: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("postSse", () => {
  it("POSTs the json body and parses the resulting stream's frames", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(sseResponse(`event: token\ndata: {"type":"token","text":"hi"}\n\n`));
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchSpy);

    const stream = await postSse("/api/ask", { json: { message: "hello" } });
    const frames = [];
    for await (const frame of stream) frames.push(frame);

    expect(frames).toEqual([{ event: "token", data: { type: "token", text: "hi" } }]);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ message: "hello" }));
  });

  it("a pre-stream failure (a real HTTP status with a JSON ErrorBody, never a 200 carrying an error) throws ApiError before any frame parsing", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    // A fresh Response per call: a Response body can only be read once, and this assertion reads
    // the same rejection's shape twice (instance, then fields).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "busy", retryAfterSeconds: 30 } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(postSse("/api/ask", { json: {} })).rejects.toBeInstanceOf(ApiError);
    await expect(postSse("/api/ask", { json: {} })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 30 });
  });

  it("throws when a 200 response carries no body at all", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    await expect(postSse("/api/ask", { json: {} })).rejects.toThrow("SSE response had no body");
  });
});
