/**
 * This screen's own network calls — POST /api/ask (guest), POST /api/threads (create/import),
 * POST /api/threads/:id/messages (a saved thread's turn), GET /api/threads/:id/messages,
 * POST /api/verify-batch, and the ?attach= GET /api/documents/:id. Everything routes through
 * src/lib/api's apiFetch/postSse, never a bespoke fetch, so offline detection, the same-origin
 * credentials rule and ApiError mapping stay uniform with the rest of the app.
 */

import { apiFetchJson } from "@/lib/api";
import { fetchDocument } from "@/lib/api/documents";
import { postSse, type SseFrame } from "@/lib/sse";
import type { AskGuestInput, AskMessageInput, CreateThreadInput, MessagesOutput, ThreadOutput } from "@/shared/contracts/threads";
import { VerifyBatchOutput, type VerifyBatchInput } from "@/shared/contracts/verify-batch";

/** Re-exported (never re-implemented) so every attachment lookup this screen makes shares the one fetcher/cache key every other document reader uses. */
export { fetchDocument };

/**
 * Parsed against its own output schema, never trusted as the cast the route handler's declared
 * return type would otherwise let through silently — a citation resolved straight from `results[i]`
 * without this would let a malformed or short response render a badge (or a citation with no
 * verification at all) the server never actually produced. A shape or length mismatch is a thrown
 * error, which the caller (ChatScreen's reopen pass) already turns into a retryable failed citation.
 */
export async function verifyBatch(citations: VerifyBatchInput["citations"], signal?: AbortSignal): Promise<VerifyBatchOutput["results"]> {
  const body: VerifyBatchInput = { citations };
  const raw = await apiFetchJson<unknown>("/api/verify-batch", { method: "POST", json: body, signal });
  const parsed = VerifyBatchOutput.safeParse(raw);
  if (!parsed.success || parsed.data.results.length !== citations.length) {
    throw new Error("verify-batch response did not match the request");
  }
  return parsed.data.results;
}

/** An unsaved (guest) turn — POST /api/ask, no threadId. */
export function askGuestStream(input: AskGuestInput, signal?: AbortSignal): Promise<AsyncGenerator<SseFrame>> {
  return postSse("/api/ask", { json: input, signal });
}

/** A turn on an already-saved thread — no documentIds/history; the thread grounds itself in its own attachments, which can only change before it existed as a saved row. */
export function askThreadStream(threadId: string, query: string, signal?: AbortSignal): Promise<AsyncGenerator<SseFrame>> {
  const body: AskMessageInput = { query };
  return postSse(`/api/threads/${encodeURIComponent(threadId)}/messages`, { json: body, signal });
}

/** Creates a fresh saved thread (a signed-in user's first turn), or imports a claimed guest thread's full history in one call. */
export async function createThread(input: CreateThreadInput): Promise<ThreadOutput> {
  return apiFetchJson<ThreadOutput>("/api/threads", { method: "POST", json: input });
}

export async function fetchThreadMessages(threadId: string, limit?: number): Promise<MessagesOutput> {
  const qs = typeof limit === "number" ? `?limit=${limit}` : "";
  return apiFetchJson<MessagesOutput>(`/api/threads/${encodeURIComponent(threadId)}/messages${qs}`);
}
