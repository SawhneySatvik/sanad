import { apiFetch } from "@/lib/api/client";
import { parseSseStream, type SseFrame } from "./parse";

export interface PostSseInit {
  json?: unknown;
  signal?: AbortSignal;
}

/**
 * POST + parse, for our own SSE vocabulary (token/final/error — src/server/http/sse.ts). Routed
 * through apiFetch so a pre-stream failure (a real HTTP status carrying a JSON ErrorBody, never a
 * 200 that then carries an error frame — the server only commits 200 once its first event is
 * already known-good) gets the exact same ApiError mapping every other route's failure does; only
 * a stream that actually committed 200 reaches the frame parser.
 */
export async function postSse(url: string, init: PostSseInit = {}): Promise<AsyncGenerator<SseFrame>> {
  const response = await apiFetch(url, { method: "POST", json: init.json, signal: init.signal });
  if (!response.body) throw new Error("SSE response had no body");
  return parseSseStream(response.body, init.signal);
}
