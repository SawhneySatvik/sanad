/**
 * Message citations repository — the only module that writes `message_citations`. Every row's
 * status, spans, and verifier_version come from a VerifyResult verify() issued for that row's quote
 * against its source document's text — there is no parameter for a status. A citation written with
 * no source is stored unlinked and not_found; one naming a document its writer cannot reach throws
 * NOT_FOUND. listVerifiedCitations always re-verifies against current text.
 */

import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { newId } from "../../db/ids";
import * as schema from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import type { InputMode, Principal } from "../core/types";
import { assertVerifyResultFor, MAX_QUOTES_PER_CALL, verify, verifyMany, type VerifyResult } from "../deterministic/verify";
import { getDocument, getDocumentSummary, isUuidShaped } from "./documents";
import { getThread } from "./threads";

/** A persisted message-citation row, as read from the database. */
export type MessageCitation = typeof schema.messageCitations.$inferSelect;

/**
 * Re-verifying costs roughly 4-8 ms per quote in the worst case, all of it blocking the event loop
 * other requests share. 100 bounds one read to about 0.8 s at the 120k characters an Ask turn can
 * ground in, and still covers a whole maximal guest import or five fully-cited Ask turns.
 */
export const MAX_VERIFIED_CITATIONS_PER_READ = 100;

/** One citation to persist for a grounded assistant message. */
export interface CitationWrite {
  quote: string;
  // The document `verification` was computed against — or null when there is none the principal can
  // reach, in which case the row is stored unlinked and not_found.
  source: { documentId: string; verification: VerifyResult } | null;
}

/** A citation freshly re-verified against its source document's current text. */
export interface VerifiedCitation {
  id: string;
  messageId: string;
  quote: string;
  // Set exactly when `verification` was computed against this document's text — then the same
  // response's ServerInternalCitationSources has its entry. null when the document is gone, not
  // accessible to the principal, or has no extracted text: verified against no text, not_found.
  sourceDocumentId: string | null;
  // verify() run by this very call. Render the document's canonicalText.slice(spanStart, spanEnd),
  // never the quote.
  verification: VerifyResult;
}

/** The text and input mode a citation's quote is verified against. */
export interface CitationDocumentText {
  canonicalText: string;
  inputMode: InputMode;
}

/** The text, hash, and input mode one cited document's citations were verified against. */
export interface CitationSource extends CitationDocumentText {
  canonicalTextHash: string;
}
/**
 * Server-internal — never serialize this. For each document cited: the exact text, hash, and input
 * mode its citations' VerifyResults were computed against, so the route layer can bind each result and
 * cut spanText server-side without ever putting the whole document on the wire. A ReadonlyMap on
 * purpose: `JSON.stringify` renders a Map as `{}`, so accidental serialization leaks nothing.
 */
export type ServerInternalCitationSources = ReadonlyMap<string, CitationSource>;

// verify()'s verdict for a quote with no document to check it against: always not_found, no spans.
function verifyWithoutDocument(quote: string): VerifyResult {
  return verify({ quote, canonicalText: "", inputMode: "text" });
}

/** Each quote verified against the document it names, one verifyMany pass per document, chunked to MAX_QUOTES_PER_CALL; a quote naming no document verifies against no text. */
export function verifyCitationQuotes(
  citations: readonly { quote: string; documentId: string | null }[],
  documents: ReadonlyMap<string, CitationDocumentText>,
): VerifyResult[] {
  const indexesByDocument = new Map<string, number[]>();
  const results: VerifyResult[] = new Array(citations.length);
  citations.forEach((citation, i) => {
    if (citation.documentId !== null && documents.has(citation.documentId)) {
      indexesByDocument.set(citation.documentId, [...(indexesByDocument.get(citation.documentId) ?? []), i]);
    } else {
      results[i] = verifyWithoutDocument(citation.quote);
    }
  });
  for (const [documentId, indexes] of indexesByDocument) {
    const document = documents.get(documentId)!;
    for (let start = 0; start < indexes.length; start += MAX_QUOTES_PER_CALL) {
      const chunk = indexes.slice(start, start + MAX_QUOTES_PER_CALL);
      const chunkResults = verifyMany(
        chunk.map((i) => citations[i].quote),
        document.canonicalText,
        document.inputMode,
      );
      chunk.forEach((index, k) => (results[index] = chunkResults[k]));
    }
  }
  return results;
}

// Citations belong to a grounded assistant message; general mode never carries one.
async function assertGroundedMessageAccess(db: Db, principal: Principal, messageId: string): Promise<void> {
  const [message] = isUuidShaped(messageId)
    ? await db
        .select({ threadId: schema.messages.threadId, role: schema.messages.role, mode: schema.messages.mode })
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId))
    : [];
  if (!message) throw notFound();
  await getThread(db, principal, message.threadId); // authorizes; throws NOT_FOUND for foreign
  if (message.role !== "assistant" || message.mode !== "grounded") {
    throw new Error("Citations can only be written for a grounded assistant message");
  }
}

/** Returns the rows in input order; ids are UUIDv7 (time-ordered) so reads return write order — the table has no created_at. */
export async function insertCitations(
  db: Db,
  principal: Principal,
  messageId: string,
  citations: readonly CitationWrite[],
): Promise<MessageCitation[]> {
  await assertGroundedMessageAccess(db, principal, messageId);
  if (citations.length === 0) return [];

  const documents = new Map<string, { canonicalTextHash: string; inputMode: InputMode }>();
  const values = [];
  for (const citation of citations) {
    let documentId: string | null = null;
    let result: VerifyResult;
    if (citation.source === null) {
      result = verifyWithoutDocument(citation.quote);
    } else {
      documentId = citation.source.documentId;
      let document = documents.get(documentId);
      if (!document) {
        // Principal-checked: a citation can only link a document its writer may read.
        const summary = await getDocumentSummary(db, principal, documentId);
        if (summary.canonicalTextHash === null || summary.inputMode === null) {
          throw new AppError("INVALID_DOCUMENT", "The document has not been extracted.", { reason: "document_not_ready" });
        }
        document = { canonicalTextHash: summary.canonicalTextHash, inputMode: summary.inputMode };
        documents.set(documentId, document);
      }
      result = citation.source.verification;
      assertVerifyResultFor(result, { quote: citation.quote, ...document });
    }
    values.push({
      id: newId(),
      messageId,
      quoteText: citation.quote,
      sourceDocumentId: documentId,
      quoteSpanStart: result.spanStart,
      quoteSpanEnd: result.spanEnd,
      verificationStatus: result.status,
      verifierVersion: result.verifierVersion,
    });
  }

  const rows = await db.insert(schema.messageCitations).values(values).returning();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return values.map((value) => byId.get(value.id)!);
}

/** How many citations each of `messageIds` (in `threadId`) has, for sizing a window before listVerifiedCitations; a citation-less message is absent. */
export async function countCitations(
  db: Db,
  principal: Principal,
  threadId: string,
  messageIds: readonly string[],
): Promise<Map<string, number>> {
  await getThread(db, principal, threadId); // authorizes; throws NOT_FOUND for foreign/missing
  const ids = messageIds.filter(isUuidShaped);
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ messageId: schema.messageCitations.messageId, citations: count() })
    .from(schema.messageCitations)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.messageCitations.messageId))
    .where(and(eq(schema.messages.threadId, threadId), inArray(schema.messageCitations.messageId, ids)))
    .groupBy(schema.messageCitations.messageId);
  return new Map(rows.map((row) => [row.messageId, row.citations]));
}

/**
 * The citations of `messageIds` that belong to `threadId`, each freshly re-verified against its
 * source document's current text, ordered by message id then write order. More than
 * MAX_VERIFIED_CITATIONS_PER_READ is a caller bug and throws before anything is verified, rather than
 * blocking the event loop or silently dropping some citations.
 */
export async function listVerifiedCitations(
  db: Db,
  principal: Principal,
  threadId: string,
  messageIds: readonly string[],
): Promise<{ citations: VerifiedCitation[]; sources: ServerInternalCitationSources }> {
  await getThread(db, principal, threadId); // authorizes; throws NOT_FOUND for foreign/missing
  const ids = messageIds.filter(isUuidShaped);
  if (ids.length === 0) return { citations: [], sources: new Map() };

  // The stored verification_status and spans are deliberately not selected.
  const rows = await db
    .select({
      id: schema.messageCitations.id,
      messageId: schema.messageCitations.messageId,
      quote: schema.messageCitations.quoteText,
      sourceDocumentId: schema.messageCitations.sourceDocumentId,
    })
    .from(schema.messageCitations)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.messageCitations.messageId))
    .where(and(eq(schema.messages.threadId, threadId), inArray(schema.messageCitations.messageId, ids)))
    .orderBy(asc(schema.messageCitations.messageId), asc(schema.messageCitations.id))
    .limit(MAX_VERIFIED_CITATIONS_PER_READ + 1);
  if (rows.length > MAX_VERIFIED_CITATIONS_PER_READ) {
    throw new Error(`listVerifiedCitations re-verifies at most ${MAX_VERIFIED_CITATIONS_PER_READ} citations per call; size the message window with countCitations`);
  }

  // One read per document: the text verified below is the text returned in `sources`.
  const sources = new Map<string, CitationSource>();
  for (const documentId of new Set(rows.map((row) => row.sourceDocumentId))) {
    if (documentId === null) continue;
    let document;
    try {
      document = await getDocument(db, principal, documentId);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") continue;
      throw error;
    }
    const { canonicalText, canonicalTextHash, inputMode } = document;
    if (document.processingStatus === "ready" && canonicalText !== null && canonicalTextHash !== null && inputMode !== null) {
      sources.set(documentId, { canonicalText, canonicalTextHash, inputMode });
    }
  }

  const citations = rows.map((row) => ({
    ...row,
    sourceDocumentId: row.sourceDocumentId !== null && sources.has(row.sourceDocumentId) ? row.sourceDocumentId : null,
  }));
  const verifications = verifyCitationQuotes(
    citations.map((citation) => ({ quote: citation.quote, documentId: citation.sourceDocumentId })),
    sources,
  );
  return { citations: citations.map((citation, i) => ({ ...citation, verification: verifications[i] })), sources };
}
