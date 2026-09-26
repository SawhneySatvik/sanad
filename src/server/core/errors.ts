/** The one error type every layer throws; kept dependency-free so any layer can import it without pulling in anything else. */

/** Every error code the app throws; HTTP status and the safe user-facing message are both derived from it. */
export const APP_ERROR_CODES = [
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "TIMEOUT",
  "INVALID_DOCUMENT",
  "EXTRACTION_FAILED",
  "SCHEMA_FAILED",
  "INVALID_CREDENTIALS",
  "EMAIL_IN_USE",
  "EMAIL_CONFIRMATION_REQUIRED",
] as const;

/** One of APP_ERROR_CODES. */
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

// A fixed, growing enum: every INVALID_DOCUMENT/EXTRACTION_FAILED throw site names one of these,
// mapped by site rather than by matching Error#message strings — sample_readonly is reserved for a
// still-unbuilt throw site (refusing to re-analyze a pre-recorded sample document).
export const ERROR_REASONS = [
  "too_large",
  "unsupported_type",
  "type_mismatch",
  "unreadable",
  "empty",
  "document_not_ready",
  "grounding_not_ready",
  "grounding_too_long",
  "sample_readonly",
] as const;

/** One of ERROR_REASONS. */
export type ErrorReason = (typeof ERROR_REASONS)[number];

/** The one exception type every layer throws; its fixed `code` drives the HTTP status and safe message. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  // Set only alongside INVALID_DOCUMENT/EXTRACTION_FAILED; a rate-limit/upstream throw uses
  // retryAfterSeconds alone.
  readonly reason?: ErrorReason;
  readonly retryAfterSeconds?: number;

  constructor(code: AppErrorCode, message: string, options?: { reason?: ErrorReason; retryAfterSeconds?: number }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.reason = options?.reason;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

// `Record<AppErrorCode, number>` — adding a new code without adding its status here is a compile
// error, not a silent runtime gap.
const HTTP_STATUS_BY_CODE: Record<AppErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  TIMEOUT: 504,
  INVALID_DOCUMENT: 422,
  EXTRACTION_FAILED: 422,
  SCHEMA_FAILED: 502,
  INVALID_CREDENTIALS: 401,
  // Same status as INVALID_CREDENTIALS — with email confirmation off, Supabase's own response body
  // already distinguishes "already registered" from "wrong password," so the status code must not
  // become a second, cheaper oracle for the same thing.
  EMAIL_IN_USE: 401,
  EMAIL_CONFIRMATION_REQUIRED: 403,
};

/** HTTP status to respond with for a given AppErrorCode. */
export function httpStatusFor(code: AppErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

// Fixed, user-facing strings only — a route handler renders this, never the raw `Error#message`/
// stack, which could echo internal detail. A resource that exists but belongs to another principal
// must respond not-found, never a 403-with-detail that would confirm it exists.
const SAFE_MESSAGE_BY_CODE: Record<AppErrorCode, string> = {
  NOT_FOUND: "The requested resource could not be found.",
  VALIDATION_FAILED: "The request could not be validated.",
  RATE_LIMITED: "Too many requests. Please try again later.",
  UPSTREAM_UNAVAILABLE: "A required service is temporarily unavailable. Please try again later.",
  TIMEOUT: "The request took too long to complete. Please try again.",
  INVALID_DOCUMENT: "The uploaded document could not be processed.",
  EXTRACTION_FAILED: "The document's text could not be extracted.",
  SCHEMA_FAILED: "The response from an upstream service was malformed.",
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  EMAIL_IN_USE: "We couldn't create an account with those details. If you already have one, sign in instead.",
  EMAIL_CONFIRMATION_REQUIRED: "Check your email to confirm your account, then sign in.",
};

/** The fixed, safe message to show the user for a given AppErrorCode; never leaks `Error#message`/stack. */
export function safeMessageFor(code: AppErrorCode): string {
  return SAFE_MESSAGE_BY_CODE[code];
}

/** Convenience constructor for the most common AppError: every repository returns this, never a 403, for a resource owned by another principal. */
export function notFound(message = safeMessageFor("NOT_FOUND")): AppError {
  return new AppError("NOT_FOUND", message);
}
