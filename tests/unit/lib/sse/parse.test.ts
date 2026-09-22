import { describe, expect, it } from "vitest";
import { parseSseStream, type SseFrame } from "@/lib/sse/parse";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(stream, signal)) frames.push(frame);
  return frames;
}

describe("parseSseStream", () => {
  it("parses a single complete frame", async () => {
    const stream = streamFromChunks([`event: token\ndata: {"type":"token","text":"Hi"}\n\n`]);
    await expect(collect(stream)).resolves.toEqual([{ event: "token", data: { type: "token", text: "Hi" } }]);
  });

  it("parses a frame split across multiple chunks at arbitrary, non-line-aligned points", async () => {
    const full = `event: token\ndata: {"type":"token","text":"Hello world"}\n\n`;
    const chunks = [full.slice(0, 5), full.slice(5, 17), full.slice(17, 40), full.slice(40)];
    const stream = streamFromChunks(chunks);
    await expect(collect(stream)).resolves.toEqual([{ event: "token", data: { type: "token", text: "Hello world" } }]);
  });

  it("parses multiple frames delivered in a single chunk", async () => {
    const stream = streamFromChunks([`event: token\ndata: {"type":"token","text":"a"}\n\nevent: token\ndata: {"type":"token","text":"b"}\n\n`]);
    await expect(collect(stream)).resolves.toEqual([
      { event: "token", data: { type: "token", text: "a" } },
      { event: "token", data: { type: "token", text: "b" } },
    ]);
  });

  it("parses a final event", async () => {
    const stream = streamFromChunks([`event: final\ndata: {"type":"final","message":{"role":"assistant"}}\n\n`]);
    await expect(collect(stream)).resolves.toEqual([{ event: "final", data: { type: "final", message: { role: "assistant" } } }]);
  });

  it("parses a mid-stream error event, matching src/server/http/sse.ts's errorFrame shape", async () => {
    const stream = streamFromChunks([`event: error\ndata: {"error":{"code":"UPSTREAM_UNAVAILABLE","message":"busy"}}\n\n`]);
    await expect(collect(stream)).resolves.toEqual([{ event: "error", data: { error: { code: "UPSTREAM_UNAVAILABLE", message: "busy" } } }]);
  });

  it("drops an unparseable frame rather than throwing, and keeps reading the rest", async () => {
    const stream = streamFromChunks([`event: token\ndata: not-json\n\nevent: token\ndata: {"type":"token","text":"ok"}\n\n`]);
    await expect(collect(stream)).resolves.toEqual([{ event: "token", data: { type: "token", text: "ok" } }]);
  });

  it("stops reading once the AbortSignal fires, never yielding a frame enqueued after abort", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulls += 1;
        if (pulls === 1) {
          ctrl.enqueue(encoder.encode(`event: token\ndata: {"type":"token","text":"a"}\n\n`));
          controller.abort();
          return;
        }
        // Reaching a second pull would mean the parser kept reading after the signal fired.
        ctrl.enqueue(encoder.encode(`event: token\ndata: {"type":"token","text":"b"}\n\n`));
      },
    });

    await expect(collect(stream, controller.signal)).resolves.toEqual([{ event: "token", data: { type: "token", text: "a" } }]);
    expect(pulls).toBe(1);
  });

  it("cancels the underlying reader on early exit (a consumer that stops iterating), not only on abort", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(encoder.encode(`event: token\ndata: {"type":"token","text":"a"}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const frame of parseSseStream(stream)) {
      expect(frame.event).toBe("token");
      break; // triggers the generator's return(), which must still release/cancel the reader
    }
    expect(cancelled).toBe(true);
  });

  it("throws a real error when the read itself fails for a reason other than an abort", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("underlying transport broke");
      },
    });

    await expect(collect(stream)).rejects.toThrow("SSE stream read failed");
  });

  it("parses CRLF-terminated frames (EventSource line-ending semantics)", async () => {
    const stream = streamFromChunks([`event: token\r\ndata: {"type":"token","text":"Hi"}\r\n\r\n`]);
    await expect(collect(stream)).resolves.toEqual([{ event: "token", data: { type: "token", text: "Hi" } }]);
  });

  it("parses a CRLF frame split across chunk boundaries right between the \\r and its \\n", async () => {
    const full = `event: token\r\ndata: {"type":"token","text":"Hi"}\r\n\r\n`;
    // Splits chosen to land exactly between a "\r" and its "\n", including at the final "\r\n\r\n".
    const splitPoints = [...full.matchAll(/\r/g)].map((m) => m.index! + 1);
    const chunks: string[] = [];
    let cursor = 0;
    for (const point of splitPoints) {
      chunks.push(full.slice(cursor, point));
      cursor = point;
    }
    chunks.push(full.slice(cursor));

    const stream = streamFromChunks(chunks);
    await expect(collect(stream)).resolves.toEqual([{ event: "token", data: { type: "token", text: "Hi" } }]);
  });

  it("throws once the buffer exceeds its cap with no frame delimiter in it", async () => {
    const oversized = `event: token\ndata: "${"x".repeat(512 * 1024 + 1)}"`; // no closing "\n\n" — never drains
    const stream = streamFromChunks([oversized]);

    await expect(collect(stream)).rejects.toThrow(/exceeded/);
  });

  it("does not throw when a single chunk exceeds the cap but carries its own closing delimiter — draining, not raw size, is what the cap guards", async () => {
    const big = "x".repeat(512 * 1024 + 50); // the accumulated buffer momentarily exceeds the cap
    const stream = streamFromChunks([`event: token\ndata: "${big}"\n\n`]);

    await expect(collect(stream)).resolves.toEqual([{ event: "token", data: big }]);
  });
});
