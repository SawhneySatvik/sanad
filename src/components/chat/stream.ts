/**
 * Consumes an ask-style SSE generator (src/server/http/sse.ts's own wire format: `event: token`,
 * `event: final`, `event: error`, one JSON `data:` line each). A pre-stream failure never reaches
 * this function at all — apiFetch (inside postSse) throws ApiError before the response's body is
 * ever handed back, since the server only commits 200 once its first event is already known-good.
 * This function only ever sees a mid-stream outcome: final, or a mid-stream `event: error` frame.
 */

import type { SseFrame } from "@/lib/sse";
import { ErrorBody } from "@/shared/contracts/common";
import { AskFinalEventOutput, AskTokenEventOutput, type AskMessageOutput } from "@/shared/contracts/threads";

export type StreamOutcome =
  | { type: "final"; message: AskMessageOutput }
  | { type: "error"; error: ErrorBody["error"] };

const GENERIC_STREAM_FAILURE: ErrorBody["error"] = { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." };

export interface ConsumeAskStreamHandlers {
  onToken: (text: string) => void;
}

export async function consumeAskStream(frames: AsyncGenerator<SseFrame>, handlers: ConsumeAskStreamHandlers): Promise<StreamOutcome> {
  for await (const frame of frames) {
    if (frame.event === "token") {
      const parsed = AskTokenEventOutput.safeParse(frame.data);
      if (parsed.success) handlers.onToken(parsed.data.text);
      continue;
    }
    if (frame.event === "final") {
      const parsed = AskFinalEventOutput.safeParse(frame.data);
      return parsed.success ? { type: "final", message: parsed.data.message } : { type: "error", error: GENERIC_STREAM_FAILURE };
    }
    if (frame.event === "error") {
      const parsed = ErrorBody.safeParse(frame.data);
      return parsed.success ? { type: "error", error: parsed.data.error } : { type: "error", error: GENERIC_STREAM_FAILURE };
    }
  }
  // The stream ended with no final/error frame at all (connection cut mid-flight) — a mid-stream
  // failure just the same, never silently treated as "nothing happened."
  return { type: "error", error: GENERIC_STREAM_FAILURE };
}
