/**
 * Ask service — chat, grounded in attached documents or general. Route handlers call ask(),
 * createThread() or listRecentMessages(), nothing else; the orchestrator is internal to ask().
 *
 * Tokens carry answer text only; every status appears in the final event, after verify() runs on
 * the completed answer and the orchestrator's citations. A saved thread's turn persists in one
 * short transaction after the stream completes, never across the LLM call; a failed or abandoned
 * turn before that point persists nothing.
 */

import type { Db } from "../../db/client";
import type { KeyValueCache } from "../cache/types";
import { AppError, type AppErrorCode, type ErrorReason } from "../core/errors";
import type { Principal } from "../core/types";
import { MAX_QUOTE_CHARS, type VerifyResult } from "../deterministic/verify";
import type { LlmClient } from "../llm/types";
import {
  classify,
  generalChatCacheKey,
  GENERAL_CHAT_CACHE_TTL_SECONDS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  parseCachedGeneralAnswer,
  runOrchestrator,
  type OrchestratorDocumentInput,
  type OrchestratorFinalEvent,
  type OrchestratorHistoryMessage,
  type SpecialistId,
} from "../orchestrator";
import { PROMPT_VERSION as ORCHESTRATOR_PROMPT_VERSION } from "../prompts/orchestrator/version";
import { getDocument } from "../data/documents";
import {
  countCitations,
  insertCitations,
  listVerifiedCitations,
  MAX_VERIFIED_CITATIONS_PER_READ,
  verifyCitationQuotes,
  type CitationDocumentText,
  type CitationSource,
  type ServerInternalCitationSources,
  type VerifiedCitation,
} from "../data/message-citations";
import {
  appendMessage,
  listRecentMessages as listMessageRows,
  MAX_RECENT_MESSAGES_LIMIT,
  type Message,
} from "../data/messages";
import { attachDocument, createThread as insertThread, listThreadDocumentIds, type Thread } from "../data/threads";

/** Dependencies ask() needs; other exported functions in this module take only `db`. */
export interface AskDeps {
  db: Db;
  /** Built per request by the composition root with createRateLimitedLlmClient: the principal is charged per LLM call there. ask() never charges a limit itself. */
  llm: LlmClient;
  timeoutMs?: number;
  /** Keys the general-chat answer cache; a real client id, never the fallback model's. Absent: caching is off. */
  modelId?: string;
  /** Absent: the general-chat answer cache is off — every turn calls the LLM, same as before this existed. */
  cache?: KeyValueCache;
}

/** Input caps. The route's zod contracts should use the same numbers; these hold even if they don't. */
export const MAX_QUERY_CHARS = 4_000;
/** Documents grounding one turn. The orchestrator's MAX_DOCUMENTS_TOTAL_CHARS still applies to their combined text. */
export const MAX_CONTEXT_DOCUMENTS = 5;
/** Longest title a caller can give a saved thread. */
export const MAX_THREAD_TITLE_CHARS = 500;
/** Most messages a guest-thread import can carry. */
export const MAX_IMPORTED_MESSAGES = MAX_RECENT_MESSAGES_LIMIT;
/** Longest content one imported message can carry. */
export const MAX_IMPORTED_MESSAGE_CHARS = 20_000;
/** Across the whole import: each one is a verify() call on the request's event loop. */
export const MAX_IMPORTED_CITATIONS = 100;
/** Distinct documents an import names (attachments and citation sources together): each is loaded with its canonical text, up to 500k characters. */
export const MAX_IMPORTED_DOCUMENTS = 10;
/** Client-held history is capped at the orchestrator's own context budget. */
export { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS };

/** Shown in place of a citation/status for a general-mode (ungrounded) answer. */
export const GENERAL_MODE_LABEL = "General information, not verified against a document.";

/** One turn of a client-held (unsaved) conversation history. */
export interface AskHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Input to ask(): a saved-thread turn (threadId set) or an unsaved turn (documentIds/history set). */
export interface AskInput {
  // Absent for an unsaved (guest) conversation.
  threadId?: string;
  query: string;
  // Unsaved turns only: a saved thread is grounded in its attached documents.
  documentIds?: readonly string[];
  // Unsaved turns only: a saved thread's history is read from the database.
  history?: readonly AskHistoryMessage[];
  // The request's signal: aborting it aborts every LLM call of the turn.
  signal?: AbortSignal;
}

/** One returned citation, freshly re-verified against the cited document's current text. */
export interface AskCitation {
  // null when the turn was not persisted.
  id: string | null;
  quote: string;
  // null when the document is missing or inaccessible.
  sourceDocumentId: string | null;
  // verify() run against the document's current canonical_text when this message was produced or
  // read. Render canonicalText.slice(spanStart, spanEnd), never the quote.
  verification: VerifyResult;
}

interface AssistantMessageBase {
  // null (with createdAt) when the turn was not persisted.
  id: string | null;
  role: "assistant";
  content: string;
  modelUsed: string;
  routedDomains: readonly string[];
  createdAt: Date | null;
}

/** An assistant turn grounded in attached documents, with its verified citations. */
export interface GroundedAssistantMessage extends AssistantMessageBase {
  mode: "grounded";
  citations: readonly AskCitation[];
}

/** An assistant turn with no document to ground it — carries no citations, status or verification. */
export interface GeneralAssistantMessage extends AssistantMessageBase {
  mode: "general";
  // The non-legal redirect (no LLM call, modelUsed "none").
  redirect: boolean;
  label: typeof GENERAL_MODE_LABEL;
}

/** A returned assistant turn: grounded (has citations) or general (has none). */
export type AssistantMessage = GroundedAssistantMessage | GeneralAssistantMessage;

/** A returned user turn. */
export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  createdAt: Date;
}

/** One turn in a returned thread history, in either role. */
export type ThreadMessage = UserMessage | AssistantMessage;

/**
 * ask()'s own typed error event — the same two-arm shape as OrchestratorErrorEvent (reason required
 * only on INVALID_DOCUMENT/EXTRACTION_FAILED), kept as its own type rather than a re-export: ask()
 * also raises this from its own AppError throws (loadTurnContext, completeTurn), not only from a
 * forwarded orchestrator event.
 */
export type AskErrorEvent =
  | { type: "error"; code: Exclude<AppErrorCode, "INVALID_DOCUMENT" | "EXTRACTION_FAILED">; reason?: undefined; retryAfterSeconds?: number }
  | { type: "error"; code: "INVALID_DOCUMENT" | "EXTRACTION_FAILED"; reason: ErrorReason; retryAfterSeconds?: number };

/** One event of ask()'s streamed turn: provisional text, the final message, or a typed error. */
export type AskEvent =
  | { type: "token"; text: string }
  // `sources` (every output that carries citations has one): server-internal, never serialized —
  // the text each linked citation was verified against, for the route to bind and cut spans with
  // (see ServerInternalCitationSources). Empty for a general-mode message.
  | { type: "final"; message: AssistantMessage; sources: ServerInternalCitationSources }
  | AskErrorEvent;

// Builds an AskErrorEvent from a thrown AppError. Every literal INVALID_DOCUMENT/EXTRACTION_FAILED
// throw site sets `reason` (a repo-wide static scan catches a literal construction that doesn't), so
// reading it here is trusting an invariant this module doesn't itself police, not guessing.
function askErrorEvent(error: AppError): AskErrorEvent {
  if (error.code === "INVALID_DOCUMENT" || error.code === "EXTRACTION_FAILED") {
    return { type: "error", code: error.code, reason: error.reason!, retryAfterSeconds: error.retryAfterSeconds };
  }
  return { type: "error", code: error.code, retryAfterSeconds: error.retryAfterSeconds };
}

/** listRecentMessages()'s return shape: the window of messages plus the text their citations were verified against. */
export interface RecentMessages {
  messages: ThreadMessage[];
  sources: ServerInternalCitationSources;
}

// Enforces "no status anywhere in a general-mode message" at the type level: no property literally
// named "status" is reachable inside it, so adding citations or a VerifyResult fails `tsc`. A
// differently named field is not caught here; the runtime test also checks for "verification".
type KeysDeep<T> = T extends readonly (infer E)[]
  ? KeysDeep<E>
  : T extends Date
    ? never
    : T extends object
      ? { [K in keyof T]-?: K | KeysDeep<T[K]> }[keyof T]
      : never;
/** True if `T` has a property literally named "status" anywhere in its nested shape. */
export type HasStatusKey<T> = "status" extends KeysDeep<T> ? true : false;
type AssertFalse<T extends false> = T;
/** Compile-time assertion: fails `tsc` if GeneralAssistantMessage ever gains a "status" key. */
export type GeneralModeHasNoStatus = AssertFalse<HasStatusKey<GeneralAssistantMessage>>;

function invalid(message: string): AppError {
  return new AppError("VALIDATION_FAILED", message);
}

interface TurnContext {
  threadId: string | null;
  documents: OrchestratorDocumentInput[];
  history: OrchestratorHistoryMessage[];
}

/**
 * Streams one chat turn as an async generator of AskEvents: "token" (provisional answer text,
 * never a status), then exactly one "final" — or one "error" and nothing after it. It never throws
 * an AppError itself: every typed failure is an "error" event. Read the first event before sending
 * anything: if it is "error", no token has been produced — respond with `httpStatusFor(code)` and
 * a JSON error body, never an SSE stream; a later "error" ends the stream, and the client discards
 * the tokens it already showed (they were never verified).
 *
 * For a saved thread, the user message, the assistant message and its citations are written in one
 * short transaction once the stream completes; an abort or error before that point persists
 * nothing — not even the user message — but once every model call has finished the turn persists
 * even if the client then disconnects. An unsaved (guest) turn persists nothing at all.
 *
 * @example
 * for await (const event of ask(deps, principal, { query: "What does clause 4 mean?" })) {
 *   if (event.type === "final") return event.message;
 * }
 */
export async function* ask(deps: AskDeps, principal: Principal, input: AskInput): AsyncGenerator<AskEvent> {
  let context: TurnContext;
  try {
    context = await loadTurnContext(deps.db, principal, input);
  } catch (error) {
    if (error instanceof AppError) {
      yield askErrorEvent(error);
      return;
    }
    throw error;
  }

  // Null unless this turn even qualifies (no document, no history — see generalCacheKeyFor); a
  // qualifying turn still only reads the cache, never trusts it blindly — parseCachedGeneralAnswer
  // rejects a malformed entry back to a normal (uncached) run below.
  const cacheKey = generalCacheKeyFor(deps, context, input.query);
  let final: OrchestratorFinalEvent | undefined;
  let cacheWriteKey: string | undefined;

  if (cacheKey !== null) {
    const raw = await deps.cache!.get(cacheKey);
    const cached = raw === null ? null : parseCachedGeneralAnswer(raw);
    if (cached !== null) {
      // Replays the exact SSE shape a live general-mode turn produces: one token event carrying
      // the whole answer, then the final event below — general mode has no verification state to
      // fast-forward past, so there is nothing else a real run would have shown first.
      yield { type: "token", text: cached.answer };
      final = {
        type: "final",
        answer: cached.answer,
        mode: "general",
        redirect: false,
        routedDomains: cached.routedDomains as readonly SpecialistId[],
        modelUsed: cached.modelUsed,
        citations: [],
      };
    }
  }

  if (!final) {
    // Drained to the end before anything is written: no transaction or connection is held while a
    // model call is in flight.
    for await (const event of runOrchestrator({
      query: input.query,
      documents: context.documents,
      history: context.history,
      llmClient: deps.llm,
      signal: input.signal,
      timeoutMs: deps.timeoutMs,
    })) {
      if (event.type === "token") {
        yield { type: "token", text: event.text };
      } else if (event.type === "error") {
        // OrchestratorErrorEvent and AskErrorEvent share the same two-arm shape, so the event forwards
        // as-is — reason and retryAfterSeconds included — with no rebuild.
        yield event;
        return;
      } else {
        final = event;
      }
    }
    if (!final) throw new Error("runOrchestrator ended without a final or error event");

    // Only a genuine, single-model general answer is written back: final.modelUsed === deps.modelId
    // excludes both the non_legal redirect (modelUsed "none") and a fallback-produced answer (the
    // fallback's own id, never the primary's) — the same rule understand.ts's result cache uses, so
    // a degraded answer never becomes the 24h answer for every later caller asking the same thing.
    if (cacheKey !== null && final.mode === "general" && !final.redirect && final.modelUsed === deps.modelId) {
      cacheWriteKey = cacheKey;
    }
  }

  let turn: CompletedTurn;
  try {
    turn = await completeTurn(deps.db, principal, context, input.query, final);
  } catch (error) {
    if (error instanceof AppError) {
      yield askErrorEvent(error);
      return;
    }
    throw error;
  }
  yield { type: "final", message: turn.message, sources: turn.sources };

  // After the final frame, never before — sse.ts's pull() calls this generator once more to learn
  // it's done, so this still runs before the HTTP stream closes, but a slow or timed-out cache
  // write can no longer delay the answer the client already has.
  if (cacheWriteKey !== undefined) {
    await deps.cache!.set(
      cacheWriteKey,
      JSON.stringify({ answer: final.answer, modelUsed: final.modelUsed, routedDomains: final.routedDomains }),
      GENERAL_CHAT_CACHE_TTL_SECONDS,
    );
  }
}

// No document, no history (first turn — a saved thread's own recent-message read, or an unsaved
// turn's client-held one, either way), a cache and a model id both supplied, and the deterministic
// classifier — no LLM call — puts the query in general mode already: cacheable. Returns null
// otherwise, including the non_legal redirect (classify() here mirrors runOrchestrator's own,
// document-free call to it exactly, so "kind" can never disagree between this check and the real run).
function generalCacheKeyFor(deps: AskDeps, context: TurnContext, query: string): string | null {
  if (deps.cache === undefined || deps.modelId === undefined) return null;
  if (context.documents.length > 0 || context.history.length > 0) return null;
  const classification = classify(query);
  if (classification.kind !== "legal") return null;
  return generalChatCacheKey({
    query,
    specialistIds: classification.domains.map((domain) => domain.id),
    modelId: deps.modelId,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  });
}

async function loadTurnContext(db: Db, principal: Principal, input: AskInput): Promise<TurnContext> {
  if (input.query.trim() === "" || input.query.length > MAX_QUERY_CHARS) {
    throw invalid(`A question must be 1-${MAX_QUERY_CHARS} characters.`);
  }
  if (input.threadId !== undefined) {
    if ((input.documentIds?.length ?? 0) > 0 || (input.history?.length ?? 0) > 0) {
      throw invalid("A saved thread uses its own attached documents and history.");
    }
    const documentIds = await listThreadDocumentIds(db, principal, input.threadId); // authorizes the thread
    const [documents, recent] = await Promise.all([
      loadContextDocuments(db, principal, documentIds),
      listMessageRows(db, principal, input.threadId, MAX_HISTORY_TURNS),
    ]);
    return { threadId: input.threadId, documents, history: boundedHistory(recent) };
  }
  const documents = await loadContextDocuments(db, principal, [...new Set(input.documentIds ?? [])]);
  return { threadId: null, documents, history: boundedHistory(input.history ?? []) };
}

// Every document is authorized before any is checked for readiness, so a foreign id is NOT_FOUND
// whatever else the request names. A document without extracted text is INVALID_DOCUMENT — the
// turn is never silently answered from fewer documents than it names.
async function loadContextDocuments(
  db: Db,
  principal: Principal,
  documentIds: readonly string[],
): Promise<OrchestratorDocumentInput[]> {
  if (documentIds.length > MAX_CONTEXT_DOCUMENTS) {
    throw invalid(`At most ${MAX_CONTEXT_DOCUMENTS} documents can ground one question.`);
  }
  // Independent owner-checked reads, capped at MAX_CONTEXT_DOCUMENTS above: one round-trip's worth
  // of latency instead of one per document.
  const documents = await Promise.all(documentIds.map((id) => getDocument(db, principal, id)));
  return documents.map((document) => {
    if (
      document.processingStatus !== "ready" ||
      document.canonicalText === null ||
      document.canonicalTextHash === null ||
      document.inputMode === null
    ) {
      throw new AppError("INVALID_DOCUMENT", "The document has not been extracted.", { reason: "document_not_ready" });
    }
    return {
      id: document.id,
      canonicalText: document.canonicalText,
      canonicalTextHash: document.canonicalTextHash,
      inputMode: document.inputMode,
      documentType: document.documentType,
    };
  });
}

// History isn't trusted in size or shape: only role and content survive, then the last
// MAX_HISTORY_TURNS, then whole turns drop from the oldest end until within MAX_HISTORY_CHARS —
// unlike the orchestrator's own bound, an over-budget latest turn is dropped too, not sent whole.
function boundedHistory(history: readonly AskHistoryMessage[]): OrchestratorHistoryMessage[] {
  const recent = history
    .slice(-MAX_HISTORY_TURNS)
    .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .map((message) => ({ role: message.role, content: message.content }));
  let total = recent.reduce((sum, message) => sum + message.content.length, 0);
  let start = 0;
  while (total > MAX_HISTORY_CHARS && start < recent.length) {
    total -= recent[start].content.length;
    start++;
  }
  return recent.slice(start);
}

interface CompletedTurn {
  message: AssistantMessage;
  sources: ServerInternalCitationSources;
}

async function completeTurn(
  db: Db,
  principal: Principal,
  context: TurnContext,
  query: string,
  final: OrchestratorFinalEvent,
): Promise<CompletedTurn> {
  const routedDomains = [...final.routedDomains];
  const threadId = context.threadId;

  if (final.mode === "general") {
    const modelUsed = final.redirect ? "none" : final.modelUsed;
    if (threadId === null) {
      const message = generalMessage({ id: null, content: final.answer, modelUsed, routedDomains, createdAt: null }, final.redirect);
      return { message, sources: new Map() };
    }
    const row = await db.transaction(async (tx) => {
      await appendMessage(tx, principal, threadId, { role: "user", content: query });
      return appendMessage(tx, principal, threadId, {
        role: "assistant",
        content: final.answer,
        mode: "general",
        modelUsed,
        routedDomains,
      });
    });
    const message = generalMessage({ id: row.id, content: row.content, modelUsed, routedDomains, createdAt: row.createdAt }, final.redirect);
    return { message, sources: new Map() };
  }

  // Only each citation's quote and document id are taken from the orchestrator; its status
  // and spans are discarded and verified again, against the same text it was given.
  const texts = new Map<string, CitationSource>(
    context.documents.map(({ id, canonicalText, canonicalTextHash, inputMode }) => [id, { canonicalText, canonicalTextHash, inputMode }]),
  );
  const claimed = final.citations
    .filter((citation) => texts.has(citation.sourceDocumentId))
    .map((citation) => ({ quote: citation.quote, documentId: citation.sourceDocumentId }));
  const verifications = verifyCitationQuotes(claimed, texts);
  // Exactly the documents the citations cite, once each — the same loaded text verify() just used.
  const sources = new Map(claimed.map((citation) => [citation.documentId, texts.get(citation.documentId)!]));

  if (threadId === null) {
    const message: GroundedAssistantMessage = {
      id: null,
      role: "assistant",
      mode: "grounded",
      content: final.answer,
      modelUsed: final.modelUsed,
      routedDomains,
      createdAt: null,
      citations: claimed.map((citation, i) => ({
        id: null,
        quote: citation.quote,
        sourceDocumentId: citation.documentId,
        verification: verifications[i],
      })),
    };
    return { message, sources };
  }

  const { row, citationRows } = await db.transaction(async (tx) => {
    await appendMessage(tx, principal, threadId, { role: "user", content: query });
    const assistant = await appendMessage(tx, principal, threadId, {
      role: "assistant",
      content: final.answer,
      mode: "grounded",
      modelUsed: final.modelUsed,
      routedDomains,
    });
    const inserted = await insertCitations(
      tx,
      principal,
      assistant.id,
      claimed.map((citation, i) => ({
        quote: citation.quote,
        source: { documentId: citation.documentId, verification: verifications[i] },
      })),
    );
    return { row: assistant, citationRows: inserted };
  });
  const message: GroundedAssistantMessage = {
    id: row.id,
    role: "assistant",
    mode: "grounded",
    content: row.content,
    modelUsed: final.modelUsed,
    routedDomains,
    createdAt: row.createdAt,
    citations: citationRows.map((citation, i) => ({
      id: citation.id,
      quote: citation.quoteText,
      sourceDocumentId: citation.sourceDocumentId,
      verification: verifications[i],
    })),
  };
  return { message, sources };
}

function generalMessage(
  base: Pick<AssistantMessageBase, "id" | "content" | "modelUsed" | "routedDomains" | "createdAt">,
  redirect: boolean,
): GeneralAssistantMessage {
  return { ...base, role: "assistant", mode: "general", redirect, label: GENERAL_MODE_LABEL };
}

// ---------------------------------------------------------------------------------------------
// Saved threads: create (optionally importing a guest's client-held thread) and read.
// ---------------------------------------------------------------------------------------------

/**
 * The fields read from a guest-store citation (src/lib/guest-thread-store.ts). Anything else the
 * client sends — unverifiedCachedStatus, status, spans, verified — is never read.
 */
export interface ImportedCitation {
  quoteText: string;
  sourceDocumentId: string;
}

/** One message of a guest thread being imported on sign-in; see createThread()'s doc for what's trusted. */
export interface ImportedMessage {
  role: "user" | "assistant";
  content: string;
  mode?: "grounded" | "general" | null;
  // Whatever the client claims produced the answer. Stored as "imported:<value>", never as a
  // model the server attests to.
  modelUsed?: string;
  citations?: readonly ImportedCitation[];
}

/** Input to createThread(). */
export interface CreateThreadInput {
  title: string;
  documentIds?: readonly string[];
  // A guest's thread, oldest first, being saved on sign-in.
  importedMessages?: readonly ImportedMessage[];
}

/** `messages` and `sources` exactly as listRecentMessages returns them (freshly verified; `sources` is server-internal, never serialized). */
export interface ThreadOutput extends RecentMessages {
  thread: Thread;
  // The documents actually attached: those the principal can read and that are extracted.
  documentIds: string[];
}

const IMPORTED_MODEL_USED_RE = /^[A-Za-z0-9._:/-]{1,64}$/;

function importedModelUsed(value: unknown): string {
  return `imported:${typeof value === "string" && IMPORTED_MODEL_USED_RE.test(value) ? value : "unknown"}`;
}

function assertImportWithinCaps(input: CreateThreadInput): void {
  if (input.title.length > MAX_THREAD_TITLE_CHARS) throw invalid(`A thread title is at most ${MAX_THREAD_TITLE_CHARS} characters.`);
  if ((input.documentIds?.length ?? 0) > MAX_CONTEXT_DOCUMENTS) {
    throw invalid(`At most ${MAX_CONTEXT_DOCUMENTS} documents can be attached to a thread.`);
  }
  const messages = input.importedMessages ?? [];
  if (messages.length > MAX_IMPORTED_MESSAGES) throw invalid(`At most ${MAX_IMPORTED_MESSAGES} messages can be imported.`);
  let citations = 0;
  for (const message of messages) {
    if (message.content.length > MAX_IMPORTED_MESSAGE_CHARS) throw invalid("An imported message is too long.");
    for (const citation of message.citations ?? []) {
      citations++;
      if (citation.quoteText.length > MAX_QUOTE_CHARS) throw invalid("An imported citation is too long.");
    }
  }
  if (citations > MAX_IMPORTED_CITATIONS) throw invalid(`At most ${MAX_IMPORTED_CITATIONS} citations can be imported.`);
}

/**
 * Creates a saved thread, optionally importing a guest's client-held thread. Threads are
 * user-owned only; a guest gets the same VALIDATION_FAILED data/threads.ts gives.
 *
 * Every client-supplied status, span and cached_* field on an imported message is discarded —
 * only role, content, mode, a model label and each citation's quote and document id are read.
 * Each citation is verified afresh against its document if the principal can read that document
 * and it is extracted; otherwise — expired, never claimed, another user's, unknown or malformed,
 * all alike — it is stored unlinked and not_found. The same rule decides which documentIds are
 * attached. A general-mode (or modeless) assistant message keeps no citations. Verification runs
 * before the transaction; the thread and everything imported into it are written in one
 * transaction, all or nothing.
 */
export async function createThread(
  deps: Pick<AskDeps, "db">,
  principal: Principal,
  input: CreateThreadInput,
): Promise<ThreadOutput> {
  if (principal.type !== "user") {
    throw invalid("Guest sessions cannot create a thread — guest threads are client-side only until saved.");
  }
  assertImportWithinCaps(input);
  const imported = input.importedMessages ?? [];

  const referenced = new Set(input.documentIds ?? []);
  for (const message of imported) {
    // Only a grounded assistant message keeps its citations; the others' are discarded unread.
    if (message.role !== "assistant" || message.mode !== "grounded") continue;
    for (const citation of message.citations ?? []) referenced.add(citation.sourceDocumentId);
  }
  if (referenced.size > MAX_IMPORTED_DOCUMENTS) throw invalid(`An import can name at most ${MAX_IMPORTED_DOCUMENTS} documents.`);
  const texts = new Map<string, CitationDocumentText>();
  for (const documentId of referenced) {
    let document;
    try {
      document = await getDocument(deps.db, principal, documentId);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") continue;
      throw error;
    }
    if (document.processingStatus === "ready" && document.canonicalText !== null && document.inputMode !== null) {
      texts.set(documentId, { canonicalText: document.canonicalText, inputMode: document.inputMode });
    }
  }
  const attachIds = [...new Set(input.documentIds ?? [])].filter((id) => texts.has(id));

  const messages = imported.map((message) => {
    if (message.role === "user") return { role: "user" as const, content: message.content, citations: [] };
    const mode = message.mode === "grounded" ? ("grounded" as const) : ("general" as const);
    const claimed =
      mode === "grounded"
        ? (message.citations ?? []).map((citation) => ({
            quote: citation.quoteText,
            documentId: texts.has(citation.sourceDocumentId) ? citation.sourceDocumentId : null,
          }))
        : [];
    return { role: "assistant" as const, content: message.content, mode, modelUsed: importedModelUsed(message.modelUsed), citations: claimed };
  });
  const verifications = verifyCitationQuotes(
    messages.flatMap((message) => message.citations),
    texts,
  );

  const thread = await deps.db.transaction(async (tx) => {
    const created = await insertThread(tx, principal, { title: input.title });
    for (const documentId of attachIds) await attachDocument(tx, principal, created.id, documentId);
    let next = 0;
    for (const message of messages) {
      if (message.role === "user") {
        await appendMessage(tx, principal, created.id, { role: "user", content: message.content });
        continue;
      }
      const row = await appendMessage(tx, principal, created.id, {
        role: "assistant",
        content: message.content,
        mode: message.mode,
        modelUsed: message.modelUsed,
      });
      const writes = message.citations.map((citation) => {
        const verification = verifications[next++];
        return {
          quote: citation.quote,
          source: citation.documentId === null ? null : { documentId: citation.documentId, verification },
        };
      });
      if (message.mode === "grounded") await insertCitations(tx, principal, row.id, writes);
    }
    return created;
  });

  return {
    thread,
    documentIds: attachIds,
    ...(await listRecentMessages(deps, principal, thread.id, { limit: MAX_RECENT_MESSAGES_LIMIT })),
  };
}

/**
 * The latest messages, oldest first: at most `limit` (capped by data/messages.ts), then shrunk from
 * the oldest end until the returned messages carry at most MAX_VERIFIED_CITATIONS_PER_READ citations
 * in total — every one of which is re-verified against its document's current canonical_text; the
 * stored status is never returned. A message comes back with all of its citations or not at all, so
 * fewer than `limit` messages can be returned while the thread holds more; those older messages are
 * simply not returned by this call (there is no paging cursor). A single message never exceeds the
 * budget: an Ask turn cites at most MAX_CITATIONS_PER_CALL (20), an import at most
 * MAX_IMPORTED_CITATIONS (100) in total. `sources` holds, once per document, exactly the text the
 * returned linked citations were verified against in this call (server-internal, never serialized).
 */
export async function listRecentMessages(
  deps: Pick<AskDeps, "db">,
  principal: Principal,
  threadId: string,
  options: { limit: number },
): Promise<RecentMessages> {
  const rows = await listMessageRows(deps.db, principal, threadId, options.limit);
  const counts = await countCitations(deps.db, principal, threadId, groundedIds(rows));
  let budget = MAX_VERIFIED_CITATIONS_PER_READ;
  let start = rows.length;
  while (start > 0 && (counts.get(rows[start - 1].id) ?? 0) <= budget) {
    budget -= counts.get(rows[start - 1].id) ?? 0;
    start--;
  }
  const window = rows.slice(start);

  const { citations, sources } = await listVerifiedCitations(deps.db, principal, threadId, groundedIds(window));
  const citationsByMessage = new Map<string, VerifiedCitation[]>();
  for (const citation of citations) {
    citationsByMessage.set(citation.messageId, [...(citationsByMessage.get(citation.messageId) ?? []), citation]);
  }
  return { messages: window.map((row) => toThreadMessage(row, citationsByMessage.get(row.id) ?? [])), sources };
}

function groundedIds(rows: readonly Message[]): string[] {
  return rows.filter((row) => row.role === "assistant" && row.mode === "grounded").map((row) => row.id);
}

function toThreadMessage(row: Message, citations: readonly VerifiedCitation[]): ThreadMessage {
  if (row.role === "user") return { id: row.id, role: "user", content: row.content, createdAt: row.createdAt };
  // messages_assistant_model_used_check: an assistant row always has one.
  const modelUsed = row.modelUsed!;
  const base = { id: row.id, content: row.content, modelUsed, routedDomains: row.routedDomainArray ?? [], createdAt: row.createdAt };
  if (row.mode === "grounded") {
    return {
      ...base,
      role: "assistant",
      mode: "grounded",
      citations: citations.map((citation) => ({
        id: citation.id,
        quote: citation.quote,
        sourceDocumentId: citation.sourceDocumentId,
        verification: citation.verification,
      })),
    };
  }
  // The redirect is persisted as general mode with model_used "none" — no other turn has one.
  return generalMessage(base, modelUsed === "none");
}
