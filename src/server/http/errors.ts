/**
 * Error to HTTP mapping and the one place the route layer logs. Of everything an error carries, a
 * response gets only its code (as a fixed status and safe message), a DocumentAnalysisError's
 * documentId and a Retry-After header; a log line gets only its code and class name. Anything but
 * an AppError is a 500 with a fixed message. Error#message, stacks, causes, ZodError issues, SQL and
 * env values are never serialized. The x-correlation-id response header matches the log line.
 */

import { AppError, httpStatusFor, safeMessageFor } from "@/server/core/errors";
import { DocumentAnalysisError } from "@/server/services/understand";
import { FORBIDDEN_CODE, INTERNAL_ERROR_CODE, type ErrorBody } from "@/shared/contracts/common";

/** The fixed message every generic (non-AppError) 500 carries. */
export const INTERNAL_ERROR_MESSAGE = "Something went wrong. Please try again.";
/** The fixed message a cross-site refusal carries. */
export const FORBIDDEN_MESSAGE = "This request is not allowed.";
/** Response header a failure's log line is correlated through. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/** An error reduced to exactly what may reach the client: status, safe body, and an optional retry hint. */
export interface MappedError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
}

// The one place a retryAfterSeconds is rounded and floored at zero — the Retry-After header and the
// body's own retryAfterSeconds must always agree, never a raw (possibly fractional or non-positive)
// value in one and a cleaned-up one in the other.
function positiveRetryAfterSeconds(retryAfterSeconds: number | undefined): number | undefined {
  if (retryAfterSeconds === undefined) return undefined;
  const rounded = Math.ceil(retryAfterSeconds);
  return rounded > 0 ? rounded : undefined;
}

/** Maps any thrown value to a MappedError: an AppError's own code/status, or a generic 500. */
export function mapError(error: unknown): MappedError {
  if (error instanceof AppError) {
    const retryAfterSeconds = positiveRetryAfterSeconds(error.retryAfterSeconds);
    return {
      status: httpStatusFor(error.code),
      body: {
        error: {
          code: error.code,
          message: safeMessageFor(error.code),
          ...(error.reason !== undefined ? { reason: error.reason } : {}),
          // Also in the Retry-After header (below) for a client that only reads headers; here too
          // so a body-only reader (an SSE error frame has no headers of its own) still sees it.
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          // The caller's own document (the service created it for this principal), so the id
          // reveals nothing; it is the only handle for retrying via POST /api/documents/:id/analyze.
          ...(error instanceof DocumentAnalysisError ? { documentId: error.documentId } : {}),
        },
      },
      retryAfterSeconds,
    };
  }
  return { status: 500, body: { error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } } };
}

/** Builds the JSON error Response for a MappedError, with the correlation-id and retry-after headers. */
export function errorResponse(mapped: MappedError, correlationId: string): Response {
  const headers = new Headers({ "cache-control": "no-store", [CORRELATION_ID_HEADER]: correlationId });
  if (mapped.retryAfterSeconds !== undefined) headers.set("retry-after", String(mapped.retryAfterSeconds));
  return Response.json(mapped.body, { status: mapped.status, headers });
}

/** Fields every request-failure log line carries. */
export interface RequestLogContext {
  correlationId: string;
  method: string;
  // URL pathname only — never the query string, which can carry a storage ref.
  path: string;
}

// An identifier-shaped class name ("ConfigError", "TypeError") tells an operator what kind of bug a
// 500 is without carrying any data; anything else is reported as plain "Error".
const ERROR_TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** Logs one request failure as a single JSON line; 5xx logs as an error, everything else as a warning. */
export function logRequestError(context: RequestLogContext, status: number, error: unknown): void {
  const code = error instanceof AppError ? error.code : INTERNAL_ERROR_CODE;
  const errorType = error instanceof Error && ERROR_TYPE_RE.test(error.name) ? error.name : "Error";
  const line = JSON.stringify({ event: "request_failed", ...context, status, code, errorType });
  if (status >= 500) console.error(line);
  else console.warn(line);
}

/** The cross-site refusal: a fixed 403 with no cookie set and nothing read but the request's own headers. */
export function crossSiteRefusal(context: RequestLogContext): Response {
  console.warn(JSON.stringify({ event: "request_refused", ...context, status: 403, code: FORBIDDEN_CODE, reason: "cross-site" }));
  return errorResponse({ status: 403, body: { error: { code: FORBIDDEN_CODE, message: FORBIDDEN_MESSAGE } } }, context.correlationId);
}
