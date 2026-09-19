/**
 * The orchestrator entry point: non-LLM classify -> fan-out at most MAX_SPECIALISTS specialists,
 * in parallel -> synthesis (only when more than one specialist ran) -> verify() the final citations,
 * unconditionally, on every grounded path, once (general mode drops citations) -> exactly one
 * "final" event, only after the stream has completed. Specialists never emit a status (schema.ts
 * has no such field); the classifier's non_legal case never calls the LLM at all.
 */

import { AppError, type AppErrorCode } from "@/server/core/errors";
import { streamEventError } from "@/server/llm/errors";
import { LLM_TIMEOUT_MS } from "@/server/llm/timeouts";
import type { LlmCompleteInput, LlmStreamEvent } from "@/server/llm/types";
import { NON_LEGAL_REDIRECT_MESSAGE } from "@/server/prompts/orchestrator/redirect";
import { AnswerStreamDecoder } from "./answer-stream-decoder";
import { buildSpecialistCallInput, buildSynthesisCallInput, type SpecialistResult } from "./build-calls";
import { verifyCitations } from "./citation-verification";
import { classify } from "./classify";
import { MAX_DOCUMENTS_TOTAL_CHARS, MAX_SPECIALISTS } from "./config";
import { capCitations, type specialistOutputSchema, type SpecialistOutput } from "./schema";
import type { SpecialistId } from "./specialist-registry";
import type { CitationsDropped, OrchestratorDocumentInput, OrchestratorErrorEvent, OrchestratorEvent, OrchestratorInput, OrchestratorMode } from "./types";

type SpecialistIdList = readonly SpecialistId[];

function combineModelsUsed(models: readonly string[]): string {
  const unique = Array.from(new Set(models)).sort();
  return unique.length > 0 ? unique.join(",") : "none";
}

// Runs before classify() and any LLM call. Two unrelated failures, kept distinct: duplicate document
// ids is a client bug (would misattribute a citation in citation-verification.ts's cursor-based
// grouping), never a document problem, so it stays VALIDATION_FAILED; an over-budget document set
// (config.ts's MAX_DOCUMENTS_TOTAL_CHARS — rejected outright, never silently truncated) is the
// document's own fault, so it's INVALID_DOCUMENT/grounding_too_long.
type DocumentValidation = { ok: true } | { ok: false; code: "VALIDATION_FAILED" } | { ok: false; code: "INVALID_DOCUMENT"; reason: "grounding_too_long" };

function validateDocuments(documents: readonly OrchestratorDocumentInput[]): DocumentValidation {
  const ids = documents.map((d) => d.id);
  if (new Set(ids).size !== ids.length) return { ok: false, code: "VALIDATION_FAILED" };
  const totalChars = documents.reduce((sum, d) => sum + d.canonicalText.length, 0);
  if (totalChars > MAX_DOCUMENTS_TOTAL_CHARS) return { ok: false, code: "INVALID_DOCUMENT", reason: "grounding_too_long" };
  return { ok: true };
}

// The LLM boundary's own AppErrorCode vocabulary never produces INVALID_DOCUMENT/EXTRACTION_FAILED —
// those are thrown only by extraction/policy code, never by an LlmClient — so this narrows the type
// for every error this module forwards from a stream()/complete() failure. The `!isLlmErrorCode`
// branch is a defensive fallback for a code that should be structurally unreachable here.
function isLlmErrorCode(code: AppErrorCode): code is Exclude<AppErrorCode, "INVALID_DOCUMENT" | "EXTRACTION_FAILED"> {
  return code !== "INVALID_DOCUMENT" && code !== "EXTRACTION_FAILED";
}

function llmErrorEvent(code: AppErrorCode, retryAfterSeconds: number | undefined): OrchestratorErrorEvent {
  if (!isLlmErrorCode(code)) return { type: "error", code: "UPSTREAM_UNAVAILABLE" };
  return { type: "error", code, retryAfterSeconds };
}

// Drains one stream() call, forwarding decoded answer text as "token" events. Returns the
// validated draft on a clean "done", or undefined after having already yielded an "error"
// event (caller must stop — no "final" follows an error, per the async generator contract).
async function* drainStream(
  stream: AsyncIterable<LlmStreamEvent<typeof specialistOutputSchema>>,
  modelsUsed: string[],
): AsyncGenerator<OrchestratorEvent, SpecialistOutput | undefined> {
  const decoder = new AnswerStreamDecoder();
  for await (const event of stream) {
    if (event.type === "token") {
      const text = decoder.push(event.token);
      if (text) yield { type: "token", text };
    } else if (event.type === "done") {
      modelsUsed.push(event.modelUsed);
      return event.data;
    } else {
      yield llmErrorEvent(event.code, streamEventError(event)?.retryAfterSeconds);
      return undefined;
    }
  }
  // A well-behaved LlmClient.stream() always ends with exactly one "done" or "error" event
  // (types.ts's own contract) — but this generator must not silently produce neither a "final" nor
  // an "error" event if a misbehaving implementation's iterable simply completes without one.
  yield { type: "error", code: "UPSTREAM_UNAVAILABLE" };
  return undefined;
}

/**
 * Runs one Ask turn: classifies the query, dispatches specialists, synthesizes and verifies. See
 * the module doc for the full pipeline and the One Guarantee contract it holds.
 *
 * @example
 * for await (const event of runOrchestrator({ query, documents, llmClient })) { ... }
 */
export async function* runOrchestrator(input: OrchestratorInput): AsyncIterable<OrchestratorEvent> {
  const documents = input.documents ?? [];
  const mode: OrchestratorMode = documents.length > 0 ? "grounded" : "general";

  const validation = validateDocuments(documents);
  if (!validation.ok) {
    yield validation.code === "VALIDATION_FAILED"
      ? { type: "error", code: "VALIDATION_FAILED" }
      : { type: "error", code: "INVALID_DOCUMENT", reason: validation.reason };
    return;
  }

  const classification = classify(input.query, documents);

  if (classification.kind === "non_legal") {
    yield { type: "token", text: NON_LEGAL_REDIRECT_MESSAGE };
    yield {
      type: "final",
      answer: NON_LEGAL_REDIRECT_MESSAGE,
      mode: "general",
      redirect: true,
      routedDomains: [],
      modelUsed: "none",
      citations: [],
    };
    return;
  }

  // One AbortController per run, sharing a signal with the caller's own `input.signal` if any, so
  // either aborting stops every call this run makes. try/finally also aborts it when the consumer
  // stops iterating early, so no LLM call from an abandoned run is left unsignaled.
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    yield* runLegal(input, documents, mode, classification.domains.map((d) => d.id), signal, controller);
  } finally {
    controller.abort();
  }
}

async function* runLegal(
  input: OrchestratorInput,
  documents: readonly OrchestratorDocumentInput[],
  mode: OrchestratorMode,
  rankedDomains: SpecialistIdList,
  signal: AbortSignal,
  controller: AbortController,
): AsyncIterable<OrchestratorEvent> {
  // classify() guarantees at least one domain whenever kind === "legal".
  const dispatched = rankedDomains.slice(0, MAX_SPECIALISTS);
  const modelsUsed: string[] = [];
  let draft: SpecialistOutput | undefined;

  if (dispatched.length === 1) {
    // Single specialist: stream its call directly and use it as the final draft — no extra
    // synthesis call.
    const callInput = withSignal(
      buildSpecialistCallInput(dispatched[0], input.query, input.history, documents, mode),
      signal,
      input.timeoutMs ?? LLM_TIMEOUT_MS.askSpecialist,
    );
    draft = yield* drainStream(input.llmClient.stream(callInput), modelsUsed);
    if (!draft) return;
  } else {
    // Multi-specialist: fan out at most MAX_SPECIALISTS non-streamed complete() calls in parallel,
    // then stream one synthesis call that combines them. Each shares the same `signal` — the first
    // to reject aborts `controller`, reflected to every sibling still in flight.
    const pending = dispatched.map((id) => {
      const callInput = withSignal(
        buildSpecialistCallInput(id, input.query, input.history, documents, mode),
        signal,
        input.timeoutMs ?? LLM_TIMEOUT_MS.askSpecialist,
      );
      return input.llmClient.complete(callInput).then(
        (result): SpecialistResult => {
          modelsUsed.push(result.modelUsed);
          // Not filtered to known documents here: that would change what the synthesis call is sent.
          const { kept, duplicate, overCap } = capCitations(result.data.citations);
          logCitationsDropped(id, { unknownDocument: 0, duplicate, overCap });
          return { id, answer: result.data.answer, citations: kept };
        },
        (error: unknown) => {
          controller.abort();
          throw error;
        },
      );
    });
    // A sibling that rejects only after Promise.all below has already settled (because it was
    // aborted, asynchronously, by another sibling's earlier rejection) would otherwise be an
    // unhandled promise rejection — this safety net doesn't change what Promise.all itself sees.
    pending.forEach((p) => p.catch(() => {}));

    let specialistResults: SpecialistResult[];
    try {
      specialistResults = await Promise.all(pending);
    } catch (error) {
      if (error instanceof AppError) {
        yield llmErrorEvent(error.code, error.retryAfterSeconds);
        return;
      }
      throw error;
    }

    const synthInput = withSignal(
      buildSynthesisCallInput(specialistResults, input.query, mode),
      signal,
      input.timeoutMs ?? LLM_TIMEOUT_MS.askSynthesis,
    );
    draft = yield* drainStream(input.llmClient.stream(synthInput), modelsUsed);
    if (!draft) return;
  }

  // verify() runs unconditionally on the final citations in grounded mode, once — never
  // per-specialist. General mode drops specialist-claimed citations entirely (nothing to check
  // them against) — OrchestratorFinalEvent's general-mode variant makes this a type error to miss.
  if (mode === "general") {
    yield {
      type: "final",
      answer: draft.answer,
      mode: "general",
      redirect: false,
      routedDomains: dispatched,
      modelUsed: combineModelsUsed(modelsUsed),
      citations: [],
    };
    return;
  }

  // Filtered to this call's own documents before dedupe and the cap: verifyCitations drops
  // the others anyway, and when they came first they used up the cap and pushed valid ones out.
  const known = new Set(documents.map((doc) => doc.id));
  const onKnownDocuments = draft.citations.filter((citation) => known.has(citation.sourceDocumentId));
  const { kept, duplicate, overCap } = capCitations(onKnownDocuments);
  const citationsDropped = { unknownDocument: draft.citations.length - onKnownDocuments.length, duplicate, overCap };
  logCitationsDropped("final", citationsDropped);
  yield {
    type: "final",
    answer: draft.answer,
    mode: "grounded",
    redirect: false,
    routedDomains: dispatched,
    modelUsed: combineModelsUsed(modelsUsed),
    citations: verifyCitations(kept, documents),
    citationsDropped,
  };
}

// One structured server-side line whenever citations are dropped, with counts only (no quote,
// no document text), so a truncated answer shows up in the logs.
function logCitationsDropped(step: string, dropped: CitationsDropped): void {
  if (dropped.unknownDocument + dropped.duplicate + dropped.overCap === 0) return;
  console.warn(JSON.stringify({ event: "llm_output_trimmed", surface: "ask", step, ...dropped }));
}

function withSignal<Schema extends typeof specialistOutputSchema>(
  callInput: LlmCompleteInput<Schema>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): LlmCompleteInput<Schema> {
  return { ...callInput, signal, timeoutMs };
}
