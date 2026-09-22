import type { ErrorBody } from "@/shared/contracts/common";
import { canonicalErrorMessage, type CanonicalErrorCode } from "@/lib/copy/errors";

interface ApiErrorInput {
  code: CanonicalErrorCode;
  correlationId?: string;
  reason?: ErrorBody["error"]["reason"];
  retryAfterSeconds?: number;
  serverMessage?: string;
}

/**
 * Thrown by apiFetch for every non-2xx response and for OFFLINE. `message` is already the
 * canonical copy — a caller never re-derives it from `code`.
 */
export class ApiError extends Error {
  readonly code: CanonicalErrorCode;
  readonly correlationId?: string;
  readonly reason?: ErrorBody["error"]["reason"];
  readonly retryAfterSeconds?: number;

  constructor(input: ApiErrorInput) {
    super(canonicalErrorMessage(input.code, { serverMessage: input.serverMessage, retryAfterSeconds: input.retryAfterSeconds }));
    this.name = "ApiError";
    this.code = input.code;
    this.correlationId = input.correlationId;
    this.reason = input.reason;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}
