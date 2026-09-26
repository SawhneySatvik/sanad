import { ErrorBody } from "@/shared/contracts/common";
import type { CanonicalErrorCode } from "@/lib/copy/errors";
import { ApiError } from "./error";
import { parseRetryAfterHeader } from "./retry-after";
import { reportNetworkFailure } from "./offline-status";

const CORRELATION_ID_HEADER = "x-correlation-id";

// Best-effort only: used when a non-2xx response arrives without a parseable ErrorBody at all (a
// proxy's own HTML error page, a truncated body) — the server-owned reason/message stay absent, but
// the status code alone still picks a passthrough-family canonical code so the caller gets *some*
// fixed copy instead of an unhandled throw.
const FALLBACK_CODE_BY_STATUS: Record<number, CanonicalErrorCode> = {
  400: "VALIDATION_FAILED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  422: "INVALID_DOCUMENT",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "SCHEMA_FAILED",
  503: "UPSTREAM_UNAVAILABLE",
  504: "TIMEOUT",
};

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** The subset of Headers apiFetch's response and putRelay's own XMLHttpRequest both satisfy — the
 * one shape errorFromParts needs, so it never has to depend on a real Response object. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Builds the one ApiError every non-2xx response becomes, from parts rather than a Response: the
 * status/headers/body triple is exactly what both apiFetch's own fetch() response and putRelay's
 * XMLHttpRequest expose, just through two different APIs — this is the shared logic neither has to
 * duplicate. `bodyText` is parsed defensively: a non-JSON or empty body (a proxy's HTML error page,
 * a direct-put signed-URL target with no JSON error shape of its own) still resolves to a fixed
 * status-based code below, never an unhandled throw.
 */
export function errorFromParts(status: number, headers: HeaderReader, bodyText: string): ApiError {
  const correlationId = headers.get(CORRELATION_ID_HEADER) ?? undefined;
  const headerRetryAfter = parseRetryAfterHeader(headers.get("retry-after"));

  let body: ErrorBody | undefined;
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(bodyText));
    if (parsed.success) body = parsed.data;
  } catch {
    // A non-JSON or empty error body still resolves to a fixed status-based code below.
  }

  const code = (body?.error.code as CanonicalErrorCode | undefined) ?? FALLBACK_CODE_BY_STATUS[status] ?? "INTERNAL_ERROR";

  return new ApiError({
    code,
    correlationId,
    reason: body?.error.reason,
    // The body's own retryAfterSeconds wins when present; the header is the fallback, matching the
    // same precedence the server itself uses to set both from one value.
    retryAfterSeconds: body?.error.retryAfterSeconds ?? headerRetryAfter,
    serverMessage: body?.error.message,
    documentId: body?.error.documentId,
  });
}

export interface ApiFetchInit extends Omit<RequestInit, "body"> {
  /** Serialized as the request body; sets content-type: application/json automatically. */
  json?: unknown;
}

/**
 * The one fetch wrapper every client-side call goes through. Throws ApiError — never a bare
 * Response or a raw fetch TypeError — for anything that isn't a 2xx, so a caller never re-derives
 * error copy from a status code itself.
 */
export async function apiFetch(input: string, init: ApiFetchInit = {}): Promise<Response> {
  if (isOffline()) throw new ApiError({ code: "OFFLINE" });

  const { json, headers, ...rest } = init;
  // A plain object spread (`{ ...headers }`) silently drops a Headers instance (it has no own
  // enumerable properties to spread) and mangles a tuple-array form — the Headers constructor is
  // the one thing that accepts all three of HeadersInit's forms correctly.
  const requestHeaders = new Headers(headers);
  if (json !== undefined) requestHeaders.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(input, {
      ...rest,
      // Every state-changing call must stay same-origin (the Sec-Fetch-Site gate) — a relative
      // `input` plus explicit same-origin credentials is what keeps it that way.
      credentials: "same-origin",
      headers: requestHeaders,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch (err) {
    // A caller's own AbortController firing must propagate as-is, never get relabelled OFFLINE —
    // only a real transport failure (fetch's own TypeError) reads as "we're offline."
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof TypeError) {
      reportNetworkFailure();
      throw new ApiError({ code: "OFFLINE" });
    }
    throw err;
  }

  if (response.ok) return response;

  // .text() rather than .json(): errorFromParts does its own JSON.parse behind the identical
  // try/catch the old inline version had, so a body-read failure (same as a non-JSON body) still
  // falls through to a status-derived code instead of throwing here.
  const bodyText = await response.text().catch(() => "");
  throw errorFromParts(response.status, response.headers, bodyText);
}

/** apiFetch, then response.json() — the shape most GET/POST callers actually want. */
export async function apiFetchJson<T>(input: string, init?: ApiFetchInit): Promise<T> {
  const response = await apiFetch(input, init);
  return (await response.json()) as T;
}

export { ApiError } from "./error";
export { parseRetryAfterHeader } from "./retry-after";
