"use client";

/**
 * The full reason matrix for a rejected or failed upload. Not role="alert" — it announces through
 * the assertive LiveRegion once on mount instead, the same pattern OfflineBanner/SignInNudge/
 * InlineNotice already use, never shadcn Alert's own implicit live role (a second, ad hoc live
 * region on top of the app's two standing ones would break the fixed live-region allow-list).
 */

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RetryAfterNotice } from "@/components/feedback/retry-after-notice";
import { canonicalErrorMessage, type CanonicalErrorCode } from "@/lib/copy/errors";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import type { UploadFlowErrorCode } from "./api";
import type { ClientPreCheckReason } from "./client-pre-checks";
import {
  CHOOSE_ANOTHER_FILE_LABEL,
  FILENAME_TOO_LONG_MESSAGE,
  REASON_COPY,
  RETRY_ANALYSIS_LABEL,
  UPLOAD_INTERRUPTED_MESSAGE,
  type UploadErrorReason,
} from "./copy";

/** A pre-check rejection never round-trips a real code — this is the one local, non-wire code. */
export type UploadCardErrorCode = UploadFlowErrorCode | "CLIENT_REJECTED";

export interface UploadCardError {
  code: UploadCardErrorCode;
  reason?: UploadErrorReason | ClientPreCheckReason;
  retryAfterSeconds?: number;
  correlationId?: string;
  documentId?: string;
}

export interface UploadErrorCardProps {
  error: UploadCardError;
  /** Bound to POST /api/documents/:id/analyze — rendered only for the 502/503/504-with-documentId family, never a 422. */
  onRetryAnalysis?: () => void;
  onChooseAnotherFile?: () => void;
}

const RETRYABLE_CODES = new Set<UploadCardErrorCode>(["UPSTREAM_UNAVAILABLE", "SCHEMA_FAILED", "TIMEOUT"]);

function isRetryAfterKind(code: UploadCardErrorCode): code is "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" {
  return code === "RATE_LIMITED" || code === "UPSTREAM_UNAVAILABLE";
}

function reasonMessage(reason: UploadErrorReason | ClientPreCheckReason): string | null {
  if (reason === "filename_too_long") return FILENAME_TOO_LONG_MESSAGE;
  return REASON_COPY[reason as UploadErrorReason] ?? null;
}

/** The one place this card's copy is decided — reason first, then the per-code fixed fallback. */
function resolveMessage(error: UploadCardError): string {
  if (error.code === "UPLOAD_INTERRUPTED") return UPLOAD_INTERRUPTED_MESSAGE;
  if (error.reason) {
    const known = reasonMessage(error.reason);
    if (known) return known;
  }
  if (error.code === "CLIENT_REJECTED") {
    // Defensive only — a real pre-check rejection always carries a matched `reason` above.
    return "The uploaded document could not be processed.";
  }
  return canonicalErrorMessage(error.code as CanonicalErrorCode);
}

/** A rejected or failed upload — never renders "Retry analysis" for a 422, whatever documentId holds. */
export function UploadErrorCard({ error, onRetryAnalysis, onChooseAnotherFile }: UploadErrorCardProps) {
  const retryAfter = isRetryAfterKind(error.code);
  const message = retryAfter ? "" : resolveMessage(error);
  const canRetryAnalysis = RETRYABLE_CODES.has(error.code) && Boolean(error.documentId) && Boolean(onRetryAnalysis);

  // RetryAfterNotice announces its own appearance; announcing the same occurrence a second time
  // here would push the assertive region twice for one error.
  useAnnounceOnMount(retryAfter ? "" : message, "assertive");

  return (
    <Alert role="note" className="items-start gap-3">
      <AlertDescription className="flex flex-col gap-3">
        {retryAfter ? (
          <RetryAfterNotice kind={error.code as "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE"} retryAfterSeconds={error.retryAfterSeconds} />
        ) : (
          <p>{message}</p>
        )}
        {canRetryAnalysis ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetryAnalysis}>
            {RETRY_ANALYSIS_LABEL}
          </Button>
        ) : (
          onChooseAnotherFile && (
            <Button type="button" variant="outline" size="sm" onClick={onChooseAnotherFile}>
              {CHOOSE_ANOTHER_FILE_LABEL}
            </Button>
          )
        )}
        {error.correlationId && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Details</summary>
            <p className="mt-1 font-mono text-[0.8125rem]">{error.correlationId}</p>
          </details>
        )}
      </AlertDescription>
    </Alert>
  );
}
