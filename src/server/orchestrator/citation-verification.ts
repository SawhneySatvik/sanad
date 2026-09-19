/**
 * The final synthesized (or single-specialist) citations, and only those, pass through verify() —
 * grouped by sourceDocumentId, chunked to verify/'s MAX_QUOTES_PER_CALL, using each document's own
 * inputMode. A citation whose sourceDocumentId isn't among the caller-supplied documents is dropped
 * entirely, never passed through with a model-written id attached: a non-UUID id would break a
 * downstream FK insert, and a real-but-foreign UUID would otherwise let an injected citation link
 * unverified content to another user's document row.
 */

import { assertVerifyResultFor, MAX_QUOTES_PER_CALL, verifyMany, type VerifyResult } from "@/server/deterministic/verify";
import type { OrchestratorCitation, OrchestratorDocumentInput } from "./types";
import type { RawCitation } from "./schema";

/** Re-verifies each citation against its own document's canonical text; see the module doc for what's dropped. */
export function verifyCitations(
  citations: readonly RawCitation[],
  documents: readonly OrchestratorDocumentInput[],
): OrchestratorCitation[] {
  const byId = new Map(documents.map((doc) => [doc.id, doc]));

  const quotesByDocument = new Map<string, string[]>();
  for (const citation of citations) {
    if (!byId.has(citation.sourceDocumentId)) continue;
    const quotes = quotesByDocument.get(citation.sourceDocumentId) ?? [];
    quotes.push(citation.quote);
    quotesByDocument.set(citation.sourceDocumentId, quotes);
  }

  const resultsByDocument = new Map<string, VerifyResult[]>();
  for (const [documentId, quotes] of quotesByDocument) {
    const doc = byId.get(documentId)!;
    const results: VerifyResult[] = [];
    for (let i = 0; i < quotes.length; i += MAX_QUOTES_PER_CALL) {
      const chunk = quotes.slice(i, i + MAX_QUOTES_PER_CALL);
      const chunkResults = verifyMany(chunk, doc.canonicalText, doc.inputMode);
      chunkResults.forEach((result, index) =>
        assertVerifyResultFor(result, { quote: chunk[index], canonicalTextHash: doc.canonicalTextHash, inputMode: doc.inputMode }),
      );
      results.push(...chunkResults);
    }
    resultsByDocument.set(documentId, results);
  }

  const cursorByDocument = new Map<string, number>();
  const out: OrchestratorCitation[] = [];
  for (const citation of citations) {
    if (!byId.has(citation.sourceDocumentId)) continue; // dropped, see file header
    const cursor = cursorByDocument.get(citation.sourceDocumentId) ?? 0;
    cursorByDocument.set(citation.sourceDocumentId, cursor + 1);
    const result = resultsByDocument.get(citation.sourceDocumentId)![cursor];
    out.push({
      quote: citation.quote,
      sourceDocumentId: citation.sourceDocumentId,
      status: result.status,
      spanStart: result.spanStart,
      spanEnd: result.spanEnd,
    });
  }
  return out;
}
