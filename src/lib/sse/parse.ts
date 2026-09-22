export interface SseFrame {
  event: string;
  data: unknown;
}

// A server that stops writing "\n\n" (a hung or misbehaving proxy) would otherwise grow this
// buffer without bound for the lifetime of the stream. Measured in UTF-16 code units, a close
// enough proxy for this near-ASCII JSON wire format without re-encoding every chunk just to check
// a bound.
const MAX_BUFFER_BYTES = 512 * 1024;

// EventSource line-ending semantics: "\r\n" and a lone "\r" are both a line terminator, exactly
// like "\n" — a proxy or an older gateway may rewrite the wire format's own "\n" to either.
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  // A frame with no data line at all (a bare comment or keepalive) carries nothing to hand back.
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    // A frame that arrived mid-write (truncated by a chunk boundary in a way buffering couldn't
    // repair) is dropped rather than thrown — one bad frame must not kill the whole stream read.
    return null;
  }
}

/**
 * Turns a fetch Response's raw byte stream into parsed frames, matching src/server/http/sse.ts's
 * wire format exactly: `event: <name>\ndata: <json>\n\n`. Buffers across chunk boundaries, so a
 * frame split mid-write by the network still parses once its remainder arrives.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel);

  try {
    while (true) {
      if (signal?.aborted) return;

      let done: boolean, value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        // A read rejects when cancel() above raced it — expected on abort, not a real stream error.
        if (signal?.aborted) return;
        throw new Error("SSE stream read failed");
      }
      if (done) return;

      buffer += decoder.decode(value, { stream: true });

      // A trailing lone "\r" might be the first half of a "\r\n" pair whose "\n" hasn't arrived
      // yet — held back out of normalization until it does, so a chunk boundary landing between
      // the two never gets read as two separate line terminators.
      const heldCr = buffer.endsWith("\r");
      const normalizable = heldCr ? buffer.slice(0, -1) : buffer;
      buffer = heldCr ? `${normalizeLineEndings(normalizable)}\r` : normalizeLineEndings(normalizable);

      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }

      if (buffer.length > MAX_BUFFER_BYTES) {
        throw new Error(`SSE buffer exceeded ${MAX_BUFFER_BYTES} bytes with no frame delimiter`);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    // Runs on every exit path, not only an explicit abort — a consumer that stops iterating early
    // (breaks out of a for-await loop) resumes this finally block the same way, and an uncancelled
    // reader would otherwise leave the underlying connection open with nothing left reading it.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
