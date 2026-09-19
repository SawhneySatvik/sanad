/**
 * Shared provider-error normalization. Every adapter funnels its transport errors through
 * `normalizeProviderError` so "never leak raw provider text or a key into an AppError message"
 * has exactly one place to hold, not one per adapter.
 */

import { AppError, type AppErrorCode, safeMessageFor } from "@/server/core/errors";
import type { LlmStreamErrorEvent } from "./types";

const RETRYABLE_CODES: ReadonlySet<AppErrorCode> = new Set(["UPSTREAM_UNAVAILABLE", "TIMEOUT", "RATE_LIMITED"]);

// A 4xx other than 408/429 means the provider rejected this request outright (dead model id, bad
// auth, a request shape it won't accept); retrying it against a secondary provider would only mask
// a real config problem. Marked non-retryable per instance, not by code, since the same code
// (UPSTREAM_UNAVAILABLE) also covers retryable outages.
const nonRetryableInstances = new WeakSet<AppError>();
// Server-side-only: the raw HTTP status a provider returned, for logging — never surfaced through
// AppError#message (always a fixed safeMessageFor() string) or exposed to a route's response.
const providerStatusByError = new WeakMap<AppError, number>();
// FallbackLlmClient.stream() only sees events, yet must tell a provider's 429 from our own limiter's
// RATE_LIMITED (both `{code: "RATE_LIMITED", retryable: true}`). Every event toStreamErrorEvent
// builds remembers its AppError here; the rate-limit decorators pass inner events through by
// identity, so the lookup still works through the composed chain.
const errorByStreamEvent = new WeakMap<LlmStreamErrorEvent, AppError>();
// Failures where no HTTP response arrived (a refused or reset connection, a DNS error). Marked where
// they are created, not inferred later from a missing status: an AppError built anywhere else has no
// status either.
const transportFailures = new WeakSet<AppError>();
// A 429 whose QuotaFailure detail named a per-day quota: it only recovers at the next daily reset,
// unlike a per-minute quota that clears within the same request's retry window.
const perDayQuotaInstances = new WeakSet<AppError>();

/** Whether an AppError code, on its own, is worth retrying against another provider tier. */
export function isRetryableProviderErrorCode(code: AppErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** Whether this specific AppError is worth retrying — narrower than the code, see `nonRetryableInstances`. */
export function isRetryableProviderError(error: unknown): error is AppError {
  return error instanceof AppError && isRetryableProviderErrorCode(error.code) && !nonRetryableInstances.has(error);
}

/** Builds a stream `error` event from an AppError — the only place `{code, retryable}` is derived. */
export function toStreamErrorEvent(error: AppError): LlmStreamErrorEvent {
  const event: LlmStreamErrorEvent = { type: "error", code: error.code, retryable: isRetryableProviderError(error) };
  errorByStreamEvent.set(event, error);
  return event;
}

/** The AppError a stream `error` event was built from, or `undefined` for one built elsewhere. */
export function streamEventError(event: LlmStreamErrorEvent): AppError | undefined {
  return errorByStreamEvent.get(event);
}

/** A failure of the provider call itself, not our own rate limiter's RATE_LIMITED or an unvalidated answer (SCHEMA_FAILED). */
export function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code === "TIMEOUT" || error.code === "UPSTREAM_UNAVAILABLE") return true;
  return error.code === "RATE_LIMITED" && providerStatusByError.get(error) === 429;
}

/** No HTTP response arrived at all; worth one immediate retry on the same provider (live Gemini calls have recovered this way). */
export function isTransportFailure(error: unknown): boolean {
  return error instanceof AppError && transportFailures.has(error);
}

/** The raw HTTP status a provider returned, or `undefined` when none was recorded. */
export function getProviderStatus(error: unknown): number | undefined {
  return error instanceof AppError ? providerStatusByError.get(error) : undefined;
}

/** Whether this 429 named a per-day quota (Google's QuotaFailure detail), not just a per-minute one. */
export function isPerDayQuotaError(error: unknown): boolean {
  return error instanceof AppError && perDayQuotaInstances.has(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// Duck-typed: both @google/genai's and openai's SDK error classes expose a numeric `.status`, and
// this also works against test fakes that never construct a real SDK error object.
function extractStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

// openai's error carries a real `retry-after` header; @google/genai's has no headers and instead
// JSON.stringifies the body into `.message`, where a 429 typically embeds `"retryDelay":"7s"`.
function extractRetryAfterSeconds(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown } | null)?.headers;
  if (headers && typeof (headers as Headers).get === "function") {
    const raw = (headers as Headers).get("retry-after");
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function tagStatus(error: AppError, status: number | undefined): AppError {
  if (status !== undefined) providerStatusByError.set(error, status);
  return error;
}

// Matched directly against the raw message: @google/genai's ApiError.message is JSON.stringify(errorBody)
// with no prefix, so this matches as written. It misses a body re-encoded inside a string field (escaped
// quotes), such as a gateway's metadata.raw.
const PER_DAY_QUOTA_RE = /"quota(?:Id|Metric)"\s*:\s*"[^"]*PerDay[^"]*"/i;

function namesPerDayQuota(message: unknown): boolean {
  return typeof message === "string" && PER_DAY_QUOTA_RE.test(message);
}

/** Which provider call failed, for the server-side log line only. `apiKey` is used solely to redact itself. */
export interface ProviderCallContext {
  model: string;
  apiKey: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function redact(text: string, apiKey: string | undefined): string {
  const withoutKey = apiKey ? text.split(apiKey).join("[redacted]") : text;
  return withoutKey.replace(/AIza[0-9A-Za-z_-]{20,}|nvapi-[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{10,}|[0-9A-Za-z_-]{32,}/g, "[redacted]");
}

// A provider's enum-like status or reason ("INVALID_ARGUMENT", "model_not_found", 404). Anything
// else — free text a gateway put where a code belongs — is dropped rather than logged.
const PROVIDER_CODE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/;

function providerCode(value: unknown, apiKey: string | undefined): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value !== "string" || !PROVIDER_CODE_RE.test(value)) return null;
  return redact(value, apiKey) === value ? value : null;
}

// Gemini's structured reason: the ErrorInfo entry of `details` ("API_KEY_INVALID"), the only part
// of details that is a code rather than text.
function errorInfoReason(detail: Record<string, unknown> | undefined): unknown {
  if (!Array.isArray(detail?.details)) return undefined;
  const info = detail.details.map(asRecord).find((d) => d?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo");
  return info?.reason;
}

// Every provider 4xx becomes a fixed safe message to callers, so this is the only place the
// provider's own reason is visible: one structured server-side line with the HTTP status and the
// provider's status/reason codes. Never the provider's message: a gateway (and Google's
// INVALID_ARGUMENT text) can quote the request back, and the request carries document text.
function logProviderRejection(error: unknown, httpStatus: number, context: ProviderCallContext | undefined): void {
  const raw = asRecord(error);
  // openai's APIError carries the parsed body's `error` object; @google/genai's ApiError carries only
  // the whole body, JSON.stringify'd, as its `message`.
  const detail = asRecord(raw?.error) ?? asRecord(asRecord(parseJson(raw?.message))?.error);
  console.warn(
    JSON.stringify({
      event: "llm_provider_rejected",
      model: context?.model ?? null,
      httpStatus,
      providerStatus: providerCode(detail?.status ?? detail?.code ?? detail?.type, context?.apiKey),
      providerReason: providerCode(errorInfoReason(detail), context?.apiKey),
    }),
  );
}

/**
 * Normalizes any transport-layer failure into the typed `AppError` vocabulary. Never reads
 * `error.message` into the result — only fixed `safeMessageFor(code)` strings. A permanent 4xx is
 * UPSTREAM_UNAVAILABLE, not SCHEMA_FAILED: SCHEMA_FAILED means the model's own answer didn't
 * validate, which a bad key or dead model id is not.
 */
export function normalizeProviderError(error: unknown, signal?: AbortSignal, context?: ProviderCallContext): AppError {
  if (error instanceof AppError) return error;
  if (signal?.aborted || isAbortError(error)) {
    return new AppError("TIMEOUT", safeMessageFor("TIMEOUT"));
  }
  const status = extractStatus(error);
  if (status !== undefined && status >= 400 && status < 500) logProviderRejection(error, status, context);
  if (status === 429) {
    const rateLimited = tagStatus(
      new AppError("RATE_LIMITED", safeMessageFor("RATE_LIMITED"), { retryAfterSeconds: extractRetryAfterSeconds(error) }),
      status,
    );
    if (namesPerDayQuota((error as { message?: unknown } | null)?.message)) perDayQuotaInstances.add(rateLimited);
    return rateLimited;
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    const nonRetryable = tagStatus(new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE")), status);
    nonRetryableInstances.add(nonRetryable);
    return nonRetryable;
  }
  // 5xx, a 408 (request timeout — retryable, same bucket as 5xx), network
  // failure, or an unrecognized shape — treated as a retryable outage.
  const outage = tagStatus(new AppError("UPSTREAM_UNAVAILABLE", safeMessageFor("UPSTREAM_UNAVAILABLE")), status);
  if (status === undefined) transportFailures.add(outage);
  return outage;
}
