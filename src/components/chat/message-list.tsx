"use client";

/**
 * Scrollable chat history. role="log" is a chat surface's own content-level live
 * region — an implicit, default aria-live="polite" region, distinct from the chrome's standing
 * regions. aria-busy suppresses a screen reader's own per-mutation announcements while a stream is
 * in flight, so StreamingPreview's accumulating text is never announced token by token; ChatScreen
 * announces the stream's completion once, explicitly, through the shared announce() helper instead.
 */

import { useEffect, useRef } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RetryAfterNotice } from "@/components/feedback/retry-after-notice";
import { AssistantMessage } from "./assistant-message";
import { StreamingPreview } from "./streaming-preview";
import { UserMessage } from "./user-message";
import type { DisplayMessage, TurnError } from "./types";

export interface MessageListProps {
  messages: readonly DisplayMessage[];
  streamingText: string | null;
  /** The last turn's own failure, if any — rendered in the assistant turn's own position, directly
   * under the user message it belongs to (or at the end of the log, for a pre-stream failure that
   * never got as far as adding one). Neutral styling, never VerificationBadge: a stream failure is
   * not a verification status. */
  error?: TurnError | null;
  onRetryError?: () => void;
}

function isRetryableCode(code: string): code is "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" {
  return code === "RATE_LIMITED" || code === "UPSTREAM_UNAVAILABLE";
}

function StreamErrorNotice({ error, onRetry }: { error: TurnError; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm text-foreground">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <div className="flex flex-1 flex-col items-start gap-2">
        {isRetryableCode(error.code) ? <RetryAfterNotice kind={error.code} retryAfterSeconds={error.retryAfterSeconds} /> : <p>{error.message}</p>}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export function MessageList({ messages, streamingText, error, onRetryError }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // jsdom (component tests) has no real layout engine and doesn't implement scrollIntoView at
    // all — guarded rather than assumed, so a test environment doesn't need to polyfill it.
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, streamingText, error]);

  return (
    <div role="log" aria-label="Chat messages" aria-busy={streamingText !== null} className="flex flex-1 flex-col gap-4 overflow-y-auto py-4">
      {messages.map((message) => (
        <div key={message.id}>{message.role === "user" ? <UserMessage content={message.content} /> : <AssistantMessage message={message} />}</div>
      ))}
      {streamingText !== null && <StreamingPreview text={streamingText} />}
      {error && onRetryError && <StreamErrorNotice error={error} onRetry={onRetryError} />}
      <div ref={bottomRef} />
    </div>
  );
}
