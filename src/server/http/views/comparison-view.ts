/**
 * compareService's ComparisonResult -> the comparisons contract's wire shape. A pure mapper: every
 * import of a service/data shape here is `import type`, erased at compile time, never a runtime
 * dependency. Each side's VerifyResult becomes a VerificationOutput bound to that side's own
 * document, via toVerificationOutput — passing documentB's text for side A's result (or vice versa)
 * throws instead of showing the wrong document's passage.
 */

import type { Document } from "@/server/data/documents";
import type { ComparisonChangeResult, ComparisonResult } from "@/server/services/compare";
import { sanitizeModelText } from "@/server/deterministic/sanitize/model-text";
import { toVerificationOutput, type VerifiedAgainst } from "../verification";

type DocumentText = Omit<VerifiedAgainst, "quote">;

// A document never leaves `ready` once it gets there, so this never actually throws in practice —
// it exists so a broken invariant fails loud instead of silently mis-binding a verification.
function requireReady(document: Document): DocumentText {
  const { canonicalText, canonicalTextHash, inputMode } = document;
  if (canonicalText === null || canonicalTextHash === null || inputMode === null) {
    throw new Error("A compared document has no canonical text.");
  }
  return { canonicalText, canonicalTextHash, inputMode };
}

/** Maps a ComparisonResult to the wire shape, binding each change's verification to its own side's document. */
export function comparisonView(result: ComparisonResult) {
  const { comparison, documentA, documentB, changes } = result;
  const sourceA = requireReady(documentA);
  const sourceB = requireReady(documentB);
  return {
    id: comparison.id,
    title: comparison.title ?? `${documentA.title ?? documentA.filename} vs ${documentB.title ?? documentB.filename}`,
    titleA: documentA.title ?? documentA.filename,
    titleB: documentB.title ?? documentB.filename,
    documentAId: comparison.documentAId,
    documentBId: comparison.documentBId,
    modelUsed: comparison.modelUsed,
    createdAt: comparison.createdAt,
    expiresAt: comparison.expiresAt,
    changes: changes.map((change) => changeView(change, sourceA, sourceB)),
  };
}

// No quoteA/quoteB on the wire — the model's raw claimed text must never ride next to a
// verified/approximate status. A side's presence is verificationX !== null; the model's own claim,
// when relevant, is inside verificationX.claimedQuote only — never a second copy at top level.
function changeView(
  change: ComparisonChangeResult,
  sourceA: DocumentText,
  sourceB: DocumentText,
) {
  return {
    id: change.id,
    changeType: change.changeType,
    explanation: change.explanationProvenance === "ai_generated" ? sanitizeModelText(change.explanation) : change.explanation,
    explanationProvenance: change.explanationProvenance,
    verificationA: sideView(change.quoteA, change.verificationA, sourceA),
    verificationB: sideView(change.quoteB, change.verificationB, sourceB),
  };
}

// A side with no quote has no status either — never call toVerificationOutput with a null quote/result pair.
function sideView(quote: string | null, verification: ComparisonChangeResult["verificationA"], source: DocumentText) {
  if (quote === null || verification === null) return null;
  return toVerificationOutput(verification, { quote, ...source });
}
