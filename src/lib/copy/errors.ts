/**
 * The one canonical client-side error-copy table. Every screen cites this, never restates a
 * code's copy itself. A `Record` keyed by
 * the full code union, not a switch with a default: adding a code to ErrorBody without adding its
 * row here is a compile error, not a silent fallthrough to the wrong copy.
 */

import type { ErrorBody } from "@/shared/contracts/common";
import { formatRetryTime } from "@/lib/format/retry-time";

export type CanonicalErrorCode = ErrorBody["error"]["code"] | "OFFLINE";

/** OfflineBanner's own standing text, reused verbatim everywhere OFFLINE appears — never reworded per screen. */
export const OFFLINE_MESSAGE = "You're offline. Saboot needs a connection to read and answer.";

interface CanonicalCopyInput {
  /** The server's own fixed per-code message — the passthrough codes render this unchanged. */
  serverMessage?: string;
  retryAfterSeconds?: number;
}

type CopyFn = (input: CanonicalCopyInput) => string;

// ≤0 or NaN reads as "no usable retry time," not "retry immediately" — a server clock skew or a
// malformed header must fall back to the vague copy, never a nonsensical "in 0 seconds."
function hasUsableRetryTime(seconds: number | undefined): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
}

// Mirrors safeMessageFor (src/server/core/errors.ts) plus INTERNAL_ERROR_MESSAGE/FORBIDDEN_MESSAGE
// (src/server/http/errors.ts) — the fallback for a passthrough code when the server's own message
// never arrives at all (a proxy's HTML error page, a truncated body, an unhandled-error response
// with no parseable ErrorBody). A parity test in tests/unit/lib/copy/ pins every string here to its
// server-side source of truth.
const FIXED_MESSAGE_BY_CODE = {
  NOT_FOUND: "The requested resource could not be found.",
  VALIDATION_FAILED: "The request could not be validated.",
  TIMEOUT: "The request took too long to complete. Please try again.",
  INVALID_DOCUMENT: "The uploaded document could not be processed.",
  EXTRACTION_FAILED: "The document's text could not be extracted.",
  SCHEMA_FAILED: "The response from an upstream service was malformed.",
  INTERNAL_ERROR: "Something went wrong. Please try again.",
  FORBIDDEN: "This request is not allowed.",
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  EMAIL_IN_USE: "We couldn't create an account with those details. If you already have one, sign in instead.",
  EMAIL_CONFIRMATION_REQUIRED: "Check your email to confirm your account, then sign in.",
} as const;

const passthroughFor =
  (code: keyof typeof FIXED_MESSAGE_BY_CODE): CopyFn =>
  ({ serverMessage }) =>
    serverMessage || FIXED_MESSAGE_BY_CODE[code];

const rateLimited: CopyFn = ({ retryAfterSeconds }) =>
  hasUsableRetryTime(retryAfterSeconds)
    ? `You've reached your limit for now. Try again in ${formatRetryTime(retryAfterSeconds)}.`
    : "You've reached your limit for now. Try again in a little while.";

const upstreamUnavailable: CopyFn = ({ retryAfterSeconds }) =>
  hasUsableRetryTime(retryAfterSeconds)
    ? `The AI providers are busy right now. Try again in ${formatRetryTime(retryAfterSeconds)}.`
    : "The AI providers are busy right now. Try again in a few minutes.";

// 404 is always exactly the server's own NOT_FOUND message — the same string whether a resource is
// missing or belongs to someone else — which passthrough already delivers unchanged, since
// safeMessageFor("NOT_FOUND") is fixed to that exact sentence server-side.
const COPY_BY_CODE: Record<CanonicalErrorCode, CopyFn> = {
  NOT_FOUND: passthroughFor("NOT_FOUND"),
  VALIDATION_FAILED: passthroughFor("VALIDATION_FAILED"),
  TIMEOUT: passthroughFor("TIMEOUT"),
  INVALID_DOCUMENT: passthroughFor("INVALID_DOCUMENT"),
  EXTRACTION_FAILED: passthroughFor("EXTRACTION_FAILED"),
  SCHEMA_FAILED: passthroughFor("SCHEMA_FAILED"),
  INTERNAL_ERROR: passthroughFor("INTERNAL_ERROR"),
  FORBIDDEN: passthroughFor("FORBIDDEN"),
  RATE_LIMITED: rateLimited,
  UPSTREAM_UNAVAILABLE: upstreamUnavailable,
  OFFLINE: () => OFFLINE_MESSAGE,
  INVALID_CREDENTIALS: passthroughFor("INVALID_CREDENTIALS"),
  EMAIL_IN_USE: passthroughFor("EMAIL_IN_USE"),
  EMAIL_CONFIRMATION_REQUIRED: passthroughFor("EMAIL_CONFIRMATION_REQUIRED"),
};

export function canonicalErrorMessage(code: CanonicalErrorCode, input: CanonicalCopyInput = {}): string {
  return COPY_BY_CODE[code](input);
}
