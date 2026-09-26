"use client";

/**
 * The one inline error banner shared verbatim by /drafts/new's create and /drafts/[id]'s revise —
 * not role="alert" (matching InlineNotice/UploadErrorCard's own pattern): it announces once through
 * the assertive LiveRegion instead, so a second ad hoc live region never joins the app's fixed
 * live-region allow-list.
 */

import { RetryAfterNotice } from "@/components/feedback/retry-after-notice";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import type { ApiError } from "@/lib/api";
import { resolveDraftErrorMessage } from "./error-copy";

export interface DraftErrorBannerProps {
  error: ApiError;
}

function isRetryAfterKind(code: string): code is "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" {
  return code === "RATE_LIMITED" || code === "UPSTREAM_UNAVAILABLE";
}

export function DraftErrorBanner({ error }: DraftErrorBannerProps) {
  const retryAfter = isRetryAfterKind(error.code);
  const message = resolveDraftErrorMessage(error);
  // RetryAfterNotice announces its own appearance; announcing the same occurrence a second time
  // here would push the assertive region twice for one error.
  useAnnounceOnMount(retryAfter ? "" : message, "assertive");

  return (
    <div role="note" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-sm text-foreground">
      {retryAfter ? <RetryAfterNotice kind={error.code} retryAfterSeconds={error.retryAfterSeconds} /> : <p>{message}</p>}
    </div>
  );
}
