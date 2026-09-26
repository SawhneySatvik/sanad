/**
 * Draft's own two INVALID_DOCUMENT reasons — every other code/reason falls back to ApiError's own
 * already-canonical `message` (built once, at throw time, by src/lib/api/error.ts against the one
 * shared error-copy table), shared verbatim between /drafts/new's create errors and /drafts/[id]'s
 * revise errors.
 */

import type { ApiError } from "@/lib/api";

const REASON_MESSAGE: Partial<Record<string, string>> = {
  grounding_not_ready: "This document is still being processed. Try again in a moment.",
  grounding_too_long: "This document is too long to draft from.",
};

export function resolveDraftErrorMessage(error: ApiError): string {
  if (error.reason && REASON_MESSAGE[error.reason]) return REASON_MESSAGE[error.reason]!;
  return error.message;
}
