/**
 * Plain input/output shapes for runOrchestrator. The orchestrator takes plain inputs, not
 * repository rows — the Ask service maps documents/messages rows onto these shapes before
 * calling in.
 */

import type { AppErrorCode, ErrorReason } from "@/server/core/errors";
import type { InputMode, VerificationStatus } from "@/server/core/types";
import type { LlmClient } from "@/server/llm/types";
import type { SpecialistId } from "./specialist-registry";

/** One turn of client-supplied conversation history passed into runOrchestrator. */
export interface OrchestratorHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * One document available to ground a query. `documentType` is intentionally a plain string (an
 * id from the document-type registry, e.g. "leave_and_license"), not an imported `DocumentTypeId`
 * — the two registries are decoupled by design (specialist-registry.ts's file header).
 */
export interface OrchestratorDocumentInput {
  readonly id: string;
  readonly canonicalText: string;
  readonly canonicalTextHash: string;
  readonly inputMode: InputMode;
  readonly documentType?: string | null;
}

/** Input to runOrchestrator. */
export interface OrchestratorInput {
  readonly query: string;
  // Absent/empty => general mode. Non-empty => grounded mode.
  readonly documents?: readonly OrchestratorDocumentInput[];
  readonly history?: readonly OrchestratorHistoryMessage[];
  readonly llmClient: LlmClient;
  // Propagated into every LLM call this run makes; `runOrchestrator` also derives its own internal
  // AbortController from this, so one specialist call rejecting or the consumer abandoning
  // iteration aborts every sibling call sharing this run's signal.
  readonly signal?: AbortSignal;
  // Per LLM call. Unset: each specialist gets LLM_TIMEOUT_MS.askSpecialist and synthesis
  // askSynthesis (llm/timeouts.ts).
  readonly timeoutMs?: number;
}

/** One returned citation, verified by verifyCitations() against its own document. */
export interface OrchestratorCitation {
  readonly quote: string;
  readonly sourceDocumentId: string;
  readonly status: VerificationStatus;
  readonly spanStart: number | null;
  readonly spanEnd: number | null;
}

/**
 * Matches the DB's `message_mode` enum exactly (src/db/migrations/0001_core_schema.sql,
 * `messages_mode_by_role_check`) — there is no third persistable mode. The non_legal
 * redirect path uses "general" (no document, nothing verified) plus `redirect: true` below
 * so the UI can still label it distinctly from a real general-mode LLM answer.
 */
export type OrchestratorMode = "grounded" | "general";

/**
 * Citations dropped before verify(): cited a document this call was not given, repeated an earlier
 * (sourceDocumentId, quote) pair exactly, or fell past MAX_CITATIONS_PER_CALL.
 */
export interface CitationsDropped {
  readonly unknownDocument: number;
  readonly duplicate: number;
  readonly overCap: number;
}

/**
 * runOrchestrator's terminal event. Discriminated on `mode`, not just typed with a generic
 * citations array: general mode's `citations` is the empty-tuple type `readonly []`, not merely
 * "usually empty" — a caller literally cannot construct a general-mode final event with a
 * non-empty citations array without a type error.
 */
export type OrchestratorFinalEvent =
  | {
      readonly type: "final";
      readonly answer: string;
      readonly mode: "general";
      readonly redirect: boolean;
      readonly routedDomains: readonly SpecialistId[];
      readonly modelUsed: string;
      readonly citations: readonly [];
    }
  | {
      readonly type: "final";
      readonly answer: string;
      readonly mode: "grounded";
      readonly redirect: false;
      readonly routedDomains: readonly SpecialistId[];
      readonly modelUsed: string;
      readonly citations: readonly OrchestratorCitation[];
      // What was dropped from the final draft's citations before verify(). Internal metadata for
      // live-validation reports: services/ask.ts reads named fields only, so it never reaches a
      // wire contract.
      readonly citationsDropped: CitationsDropped;
    };

/**
 * runOrchestrator's typed error event. Split into two arms, not one `code: AppErrorCode` field, so a
 * caller constructing an INVALID_DOCUMENT/EXTRACTION_FAILED error event with no `reason` fails to
 * compile — the reason-coverage architecture test is the runtime backstop for every other code.
 */
export type OrchestratorErrorEvent =
  | {
      readonly type: "error";
      readonly code: Exclude<AppErrorCode, "INVALID_DOCUMENT" | "EXTRACTION_FAILED">;
      readonly reason?: undefined;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly type: "error";
      readonly code: "INVALID_DOCUMENT" | "EXTRACTION_FAILED";
      readonly reason: ErrorReason;
      readonly retryAfterSeconds?: number;
    };

/** One event of runOrchestrator's stream: provisional text, the final event, or a typed error. */
export type OrchestratorEvent =
  | { readonly type: "token"; readonly text: string }
  | OrchestratorFinalEvent
  | OrchestratorErrorEvent;
