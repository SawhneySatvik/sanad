"use client";

/**
 * The workspace's own page-scoped Ask conversation — never persisted, discarded on
 * "Continue in chat"/unmount. Every turn grounds in exactly this document (documentIds: [id]), so
 * `mode` is always expected back "grounded"; the general-mode branch is still handled generically
 * since it's a real discriminated union the server decides, not the client.
 *
 * Hand-rolled fetch + SSE reader, not a TanStack Query/mutation (Query doesn't model a stream) —
 * `streamingText`/`status` are local state fed by chat's own consumeAskStream (src/components/chat/
 * stream.ts), reused here rather than re-implemented, so a frame is always schema-parsed and a
 * stream that ends with neither `final` nor `error` still resolves to an error status instead of
 * leaving `status` stuck on "streaming" forever. A mid-stream `event: error` discards the in-flight
 * preview entirely (never appended-to or frozen) and requires a manual "Retry" — it never resends on
 * its own. `send` is a no-op while a turn is already streaming, so a second Enter/click can't abort
 * the first turn's own in-flight stream out from under it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { postSse } from "@/lib/sse";
import { ApiError } from "@/lib/api";
import { canonicalErrorMessage } from "@/lib/copy/errors";
import { consumeAskStream } from "@/components/chat/stream";
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, type AskMessageOutput } from "@/shared/contracts/threads";

export interface AskUserTurn {
  role: "user";
  id: string;
  content: string;
}

export type AskTurn = AskUserTurn | (AskMessageOutput & { id: string });

export type AskStatus = "idle" | "streaming" | "error";

export interface UseAskConversationResult {
  composerValue: string;
  setComposerValue: (value: string) => void;
  turns: AskTurn[];
  streamingText: string | null;
  status: AskStatus;
  errorMessage: string | null;
  send: (query: string) => void;
  retry: () => void;
}

let turnIdSeq = 0;
function nextTurnId(): string {
  turnIdSeq += 1;
  return `ask-turn-${turnIdSeq}`;
}

export function useAskConversation(documentId: string): UseAskConversationResult {
  const [composerValue, setComposerValue] = useState("");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [status, setStatus] = useState<AskStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastQueryRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  // True for exactly the duration of one run() call — checked synchronously by send() so a second
  // Enter/click before the first turn's own stream settles is a no-op, never a fresh fetch that
  // aborts the first (state updates are async; a ref is what makes the guard work across two send()
  // calls in the same tick).
  const streamingRef = useRef(false);

  const run = useCallback(
    async (query: string) => {
      lastQueryRef.current = query;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = true;

      setStatus("streaming");
      setErrorMessage(null);
      setStreamingText("");

      // AskGuestInput caps history at MAX_HISTORY_TURNS turns of at most MAX_HISTORY_CHARS each — a
      // turn over budget is dropped outright (never truncated, which would silently change what was
      // actually said), then the most recent MAX_HISTORY_TURNS survivors are kept.
      const history = turns
        .map((turn) => ({ role: turn.role, content: turn.content }))
        .filter((turn) => turn.content.length <= MAX_HISTORY_CHARS)
        .slice(-MAX_HISTORY_TURNS);

      try {
        const frames = await postSse("/api/ask", {
          json: { query, documentIds: [documentId], history },
          signal: controller.signal,
        });
        const outcome = await consumeAskStream(frames, { onToken: (text) => setStreamingText((prev) => (prev ?? "") + text) });
        if (controller.signal.aborted) return;
        if (outcome.type === "final") {
          setTurns((prev) => [...prev, { ...outcome.message, id: nextTurnId() }]);
          setStreamingText(null);
          setStatus("idle");
        } else {
          setStreamingText(null);
          setErrorMessage(outcome.error.message);
          setStatus("error");
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setStreamingText(null);
        setErrorMessage(err instanceof ApiError ? canonicalErrorMessage(err.code, { retryAfterSeconds: err.retryAfterSeconds }) : "Something went wrong. Please try again.");
        setStatus("error");
      } finally {
        // Guards identity, not just truthiness: a newer run() (retry() firing while this one was
        // still in flight) already flipped this back to true for itself — this stale call's own
        // finally must never clobber that.
        if (abortRef.current === controller) streamingRef.current = false;
      }
    },
    [documentId, turns],
  );

  const send = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed || streamingRef.current) return;
      setTurns((prev) => [...prev, { role: "user", id: nextTurnId(), content: trimmed }]);
      setComposerValue("");
      void run(trimmed);
    },
    [run],
  );

  const retry = useCallback(() => {
    if (!lastQueryRef.current) return;
    void run(lastQueryRef.current);
  }, [run]);

  // An abandoned stream otherwise keeps parsing tokens into an unmounted component and holds the
  // connection open needlessly.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { composerValue, setComposerValue, turns, streamingText, status, errorMessage, send, retry };
}
