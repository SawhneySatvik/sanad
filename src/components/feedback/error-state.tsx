"use client";

import { canonicalErrorMessage, type CanonicalErrorCode } from "@/lib/copy/errors";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import { Button } from "@/components/ui/button";
import { RetryAfterNotice } from "./retry-after-notice";

export interface ErrorStateProps {
  code: CanonicalErrorCode;
  correlationId?: string;
  /**
   * The server's own fixed per-code message (ErrorBody.error.message). Every passthrough code's
   * copy is "the server's own fixed message" by definition, and this component has no other way
   * to know it without either re-fetching or duplicating the server's per-code string table
   * client-side (a drift risk the passthrough design deliberately avoids). Ignored for
   * RATE_LIMITED/UPSTREAM_UNAVAILABLE/OFFLINE, whose copy never varies by server text.
   */
  serverMessage?: string;
  /** RetryAfterNotice needs this to render its own countdown copy for RATE_LIMITED/UPSTREAM_UNAVAILABLE. */
  retryAfterSeconds?: number;
  onRetry?: () => void;
}

function isRetryable(code: CanonicalErrorCode): code is "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" {
  return code === "RATE_LIMITED" || code === "UPSTREAM_UNAVAILABLE";
}

/** A reusable full-region error, for a failed GET or a route error boundary. */
export function ErrorState({ code, correlationId, serverMessage, retryAfterSeconds, onRetry }: ErrorStateProps) {
  const retryable = isRetryable(code);
  const message = canonicalErrorMessage(code, { serverMessage, retryAfterSeconds });
  // RetryAfterNotice announces its own appearance for the retryable codes — announcing here too
  // would push the assertive region twice for the same occurrence.
  useAnnounceOnMount(retryable ? "" : message, "assertive");

  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6 text-sm text-foreground">
      {retryable ? <RetryAfterNotice kind={code} retryAfterSeconds={retryAfterSeconds} /> : <p>{message}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
      {correlationId && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 font-mono text-[0.8125rem]">{correlationId}</p>
        </details>
      )}
    </div>
  );
}
