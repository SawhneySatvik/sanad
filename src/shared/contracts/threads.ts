/**
 * POST /api/threads, GET/POST /api/threads/:id/messages, POST /api/ask. Caps below mirror ask.ts's
 * own constants, as literal copies since a contract may not import server code. No request schema
 * has a status/span/cached_* field: `ImportedCitationInput`/`ImportedMessageInput` use z.object (not
 * strict), so a client-supplied status is discarded, not rejected. Id fields inside a JSON body are
 * a bounded plain string, never `z.guid()`, so a malformed one reaches the service and gets the same
 * answer as a foreign or missing id, instead of its own distinguishing status.
 */

import { z } from "zod";
import { IsoDateTime, VerificationOutput } from "./common";
import { INPUT_MODES } from "./vocabulary";

// ---- caps (mirror src/server/services/ask.ts's own exported constants) ----
/** Max characters in one query. */
export const MAX_QUERY_CHARS = 4_000;
/** Max documents attached to one turn. */
export const MAX_CONTEXT_DOCUMENTS = 5;
/** Max characters in a thread title. */
export const MAX_THREAD_TITLE_CHARS = 500;
/** Max messages a sign-in import may carry. */
export const MAX_IMPORTED_MESSAGES = 200;
/** Max characters in one imported message's content. */
export const MAX_IMPORTED_MESSAGE_CHARS = 20_000;
/** Max citations across an entire import, aggregated. */
export const MAX_IMPORTED_CITATIONS = 100;
/** Mirrors verify()'s MAX_QUOTE_CHARS; a longer quoteText fails the request body. */
export const MAX_QUOTE_CHARS = 4_000;
/** Max history turns sent per call. */
export const MAX_HISTORY_TURNS = 12;
/** Max characters per history turn; a turn over budget is dropped, not truncated. */
export const MAX_HISTORY_CHARS = 6_000;
/** Max `limit` a caller may request when listing messages. */
export const MAX_LIST_MESSAGES_LIMIT = 200;
/** Default page size when listing messages. */
export const DEFAULT_LIST_MESSAGES_LIMIT = 50;

/**
 * POST /api/threads' `maxBodyBytes` override: route()'s default 1 MiB body cap rejects the
 * largest contract-valid CreateThreadInput with a generic 400. Worst-case UTF-8 byte math across
 * title, documentIds, importedMessages and their aggregate citations sums to ~12.72 MiB; this
 * rounds up to a clean power-of-two with ~25% headroom.
 */
export const MAX_CREATE_THREAD_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB

/** Fixed string ask.ts's GENERAL_MODE_LABEL emits, duplicated since a contract may not import server code. */
export const GENERAL_MODE_LABEL = "General information, not verified against a document.";

// A body-carried id: bounded, but never guid-validated — see file header.
const LooseId = z.string().min(1).max(255);

/** One turn of client-held history sent alongside a guest ask. */
export const AskHistoryMessageInput = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_HISTORY_CHARS),
});
export type AskHistoryMessageInput = z.infer<typeof AskHistoryMessageInput>;

/** The guest/unsaved-turn body; no threadId field exists at all, since an unsaved turn never carries one. */
export const AskGuestInput = z.strictObject({
  query: z.string().min(1).max(MAX_QUERY_CHARS),
  documentIds: z.array(LooseId).max(MAX_CONTEXT_DOCUMENTS).optional(),
  history: z.array(AskHistoryMessageInput).max(MAX_HISTORY_TURNS).optional(),
});
export type AskGuestInput = z.infer<typeof AskGuestInput>;

/**
 * A saved thread's turn body; names only the query, since the thread grounds itself in its own
 * attached documents and history.
 */
export const AskMessageInput = z.strictObject({
  query: z.string().min(1).max(MAX_QUERY_CHARS),
});
export type AskMessageInput = z.infer<typeof AskMessageInput>;

/** GET /api/threads/:id/messages' query. */
export const ListMessagesInput = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_MESSAGES_LIMIT).optional(),
});
export type ListMessagesInput = z.infer<typeof ListMessagesInput>;

/**
 * One imported citation; never strict — declaring no status/span/cached_* key is what keeps one
 * off, not rejecting a request for carrying one.
 */
export const ImportedCitationInput = z.object({
  quoteText: z.string().min(1).max(MAX_QUOTE_CHARS),
  sourceDocumentId: LooseId,
});
export type ImportedCitationInput = z.infer<typeof ImportedCitationInput>;

/** One imported message from a claimed guest thread. */
export const ImportedMessageInput = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_IMPORTED_MESSAGE_CHARS),
  mode: z.enum(["grounded", "general"]).nullable().optional(),
  modelUsed: z.string().max(64).optional(),
  citations: z.array(ImportedCitationInput).max(MAX_IMPORTED_CITATIONS).optional(),
});
export type ImportedMessageInput = z.infer<typeof ImportedMessageInput>;

/** POST /api/threads' request body — user principal only, a guest gets a typed VALIDATION_FAILED. */
// The `.refine` below caps total citations across every imported message at MAX_IMPORTED_CITATIONS:
// the service counts citations aggregated across the whole import, not per message, so
// `ImportedMessageInput.citations` alone would let this contract admit far more than the service allows.
export const CreateThreadInput = z
  .strictObject({
    title: z.string().max(MAX_THREAD_TITLE_CHARS),
    documentIds: z.array(LooseId).max(MAX_CONTEXT_DOCUMENTS).optional(),
    importedMessages: z.array(ImportedMessageInput).max(MAX_IMPORTED_MESSAGES).optional(),
  })
  .refine(
    (input) => (input.importedMessages ?? []).reduce((sum, message) => sum + (message.citations?.length ?? 0), 0) <= MAX_IMPORTED_CITATIONS,
    { message: `At most ${MAX_IMPORTED_CITATIONS} citations can be imported in total.`, path: ["importedMessages"] },
  );
export type CreateThreadInput = z.infer<typeof CreateThreadInput>;

// ---- response shapes ----

/**
 * A citation the way every route shows one: the document it named, plus the shared
 * VerificationOutput — never a raw VerifyResult, never spanText built here, and no top-level
 * `quote`/model-text field. The model's claim is reachable only through `verification.claimedQuote`.
 * `inputMode` is null when the citation is unlinked (no source document to report a mode for) — a
 * scanned source shows ScannedNotice in chat the same as everywhere else it appears.
 */
export const AskCitationOutput = z.object({
  id: z.guid().nullable(),
  sourceDocumentId: z.guid().nullable(),
  inputMode: z.enum(INPUT_MODES).nullable(),
  verification: VerificationOutput,
});
export type AskCitationOutput = z.infer<typeof AskCitationOutput>;

// `provenance: "ai_generated"`: every assistant message's `content` is model-produced text
// (general mode's redirect included), so every consumer gets an explicit constant marker rather
// than inferring it from `role: "assistant"`.
const AssistantMessageBase = {
  id: z.guid().nullable(),
  role: z.literal("assistant"),
  content: z.string(),
  provenance: z.literal("ai_generated"),
  modelUsed: z.string(),
  routedDomains: z.array(z.string()),
  createdAt: IsoDateTime.nullable(),
};

/** A grounded assistant message: model text plus its citations. */
export const GroundedAssistantMessageOutput = z.object({
  ...AssistantMessageBase,
  mode: z.literal("grounded"),
  citations: z.array(AskCitationOutput),
});
export type GroundedAssistantMessageOutput = z.infer<typeof GroundedAssistantMessageOutput>;

/**
 * A general-mode message: no citations/verification key anywhere; `label` is the fixed
 * GENERAL_MODE_LABEL string, never model text.
 */
export const GeneralAssistantMessageOutput = z.object({
  ...AssistantMessageBase,
  mode: z.literal("general"),
  redirect: z.boolean(),
  label: z.literal(GENERAL_MODE_LABEL),
});
export type GeneralAssistantMessageOutput = z.infer<typeof GeneralAssistantMessageOutput>;

/** An assistant message's wire shape: grounded (with citations) or general (with a fixed disclaimer label). */
export const AskMessageOutput = z.discriminatedUnion("mode", [
  GroundedAssistantMessageOutput,
  GeneralAssistantMessageOutput,
]);
export type AskMessageOutput = z.infer<typeof AskMessageOutput>;

/** A user-authored message's wire shape. */
export const UserMessageOutput = z.object({
  id: z.guid(),
  role: z.literal("user"),
  content: z.string(),
  createdAt: IsoDateTime,
});
export type UserMessageOutput = z.infer<typeof UserMessageOutput>;

/** One thread message, user or assistant. Not a discriminatedUnion("role"): grounded/general share role "assistant". */
export const ThreadMessageOutput = z.union([UserMessageOutput, AskMessageOutput]);
export type ThreadMessageOutput = z.infer<typeof ThreadMessageOutput>;

/** GET /api/threads/:id/messages' response. */
export const MessagesOutput = z.object({ messages: z.array(ThreadMessageOutput) });
export type MessagesOutput = z.infer<typeof MessagesOutput>;

/** A thread's wire shape; owner columns deliberately absent. */
export const ThreadSummaryOutput = z.object({
  id: z.guid(),
  projectId: z.guid().nullable(),
  title: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSummaryOutput = z.infer<typeof ThreadSummaryOutput>;

/** POST /api/threads' response: the created thread and its messages. */
export const ThreadOutput = z.object({
  thread: ThreadSummaryOutput,
  documentIds: z.array(z.guid()),
  messages: z.array(ThreadMessageOutput),
});
export type ThreadOutput = z.infer<typeof ThreadOutput>;

// ---- SSE events (POST /api/ask, POST /api/threads/:id/messages) ----

/** A streamed token chunk. */
export const AskTokenEventOutput = z.object({ type: z.literal("token"), text: z.string() });
export type AskTokenEventOutput = z.infer<typeof AskTokenEventOutput>;

/** The stream's last event, carrying the complete assistant message. */
export const AskFinalEventOutput = z.object({ type: z.literal("final"), message: AskMessageOutput });
export type AskFinalEventOutput = z.infer<typeof AskFinalEventOutput>;

// The error variant is handled entirely by the SSE layer before either schema above ever runs
// (the first event decides the HTTP status) — deliberately not a member of this union.
/** The non-error stream event shapes an ask-style route emits. */
export const AskEventOutput = z.discriminatedUnion("type", [AskTokenEventOutput, AskFinalEventOutput]);
export type AskEventOutput = z.infer<typeof AskEventOutput>;
