/**
 * Provider-neutral LLM interface. No adapter's SDK types leak past this boundary — every field is
 * a plain primitive, a caller-supplied zod schema, or a type owned by this module.
 */

import type { ZodType, z } from "zod";
import type { AppErrorCode } from "@/server/core/errors";

/**
 * A document the model should see. `canonicalText` is server-extracted text; `nativeFile` is valid
 * only when `capabilities.nativeDocumentInput` is true, checked at the call site. The union type
 * enforces that exactly one of the two is ever set.
 */
export type LlmDocumentInput =
  | { canonicalText: string; nativeFile?: undefined }
  | { canonicalText?: undefined; nativeFile: { bytes: Uint8Array; mimeType: string } };

/** What one LLM client can do — used to route a request and to reject unsupported document input. */
export interface LlmCapabilities {
  /** Every adapter supports it: every call site passes a zod schema. */
  readonly structuredOutput: true;
  readonly nativeDocumentInput: boolean;
  readonly streaming: boolean;
}

/** Token counts for one LLM call. */
export interface LlmTokensUsed {
  input: number;
  output: number;
}

/** Inputs for one structured LLM call or stream. */
export interface LlmCompleteInput<Schema extends ZodType> {
  systemPrompt: string;
  userPrompt: string;
  schema: Schema;
  documents?: LlmDocumentInput[];
  signal?: AbortSignal;
  /** Bounds this call, including any repair retry, and the whole FallbackLlmClient chain; see llm/timeouts.ts. */
  timeoutMs?: number;
  /** Gemini's thinking-token budget (0 disables it); ignored by clients built without `sendThinkingBudget` and by Gemma. */
  thinkingBudget?: number;
}

/** Result of one successful structured LLM call. */
export interface LlmCompleteResult<Schema extends ZodType> {
  data: z.infer<Schema>;
  /** Names the tier that actually answered — never relabelled to the chain's primary. */
  modelUsed: string;
  /** Summed across every provider attempt actually made, including a repair retry. */
  tokensUsed: LlmTokensUsed;
}

/**
 * `token` events are provisional raw text, not yet schema-validated; an `error` event means no
 * `done` follows, and every token already emitted must be discarded — none of it was ever verified.
 * `retryable` reflects the specific AppError instance (`isRetryableProviderError` in errors.ts): two
 * failures with the same `code` can differ, since a 5xx and a non-retryable 4xx both normalize to
 * `UPSTREAM_UNAVAILABLE`.
 */
export interface LlmStreamErrorEvent {
  type: "error";
  code: AppErrorCode;
  retryable: boolean;
}

/** One event in an LLM stream: token text, the final validated result, or a typed error. */
export type LlmStreamEvent<Schema extends ZodType> =
  | { type: "token"; token: string }
  | { type: "done"; data: z.infer<Schema>; modelUsed: string; tokensUsed: LlmTokensUsed }
  | LlmStreamErrorEvent;

/** A single LLM call, or its streamed equivalent, behind one provider-neutral contract. */
export interface LlmClient {
  readonly capabilities: LlmCapabilities;
  /** Runs one call and returns the schema-validated result once the provider has fully answered. */
  complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>>;
  /** Streams tokens as they arrive; the final `done` event carries the schema-validated result. */
  stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>>;
}
