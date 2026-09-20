/**
 * compareService's ComparisonResult -> the comparisons contract's wire shape. A pure mapper: every
 * import of a service/data shape here is `import type`, erased at compile time, never a runtime
 * dependency. Each side's VerifyResult becomes a VerificationOutput bound to that side's own
 * document, via toVerificationOutput — passing documentB's text for side A's result (or vice versa)
 * throws instead of showing the wrong document's passage.
 */

import type { Document } from "@/server/data/documents";
import type { ComparisonChangeResult, ComparisonResult } from "@/server/services/compare";
import { toVerificationOutput, type VerifiedAgainst } from "../verification";

type DocumentText = Omit<VerifiedAgainst, "quote">;

// Mirrors compare.ts's own NO_MODEL_USED sentinel — duplicated as a literal, not imported, since a
// view is a pure mapper and may not value-import from the services layer.
const NO_MODEL_USED = "none";

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
  // Coarse-grained, per comparison rather than per change: "templated" only when no model call was
  // made for the whole comparison at all (the service doesn't expose a finer distinction).
  const explanationProvenance = comparison.modelUsed === NO_MODEL_USED ? ("templated" as const) : ("ai_generated" as const);
  return {
    id: comparison.id,
    documentAId: comparison.documentAId,
    documentBId: comparison.documentBId,
    modelUsed: comparison.modelUsed,
    createdAt: comparison.createdAt,
    expiresAt: comparison.expiresAt,
    changes: changes.map((change) => changeView(change, sourceA, sourceB, explanationProvenance)),
  };
}

// No quoteA/quoteB on the wire — the model's raw claimed text must never ride next to a
// verified/approximate status. A side's presence is verificationX !== null; the model's own claim,
// when relevant, is inside verificationX.claimedQuote only — never a second copy at top level.
function changeView(
  change: ComparisonChangeResult,
  sourceA: DocumentText,
  sourceB: DocumentText,
  explanationProvenance: "ai_generated" | "templated",
) {
  return {
    id: change.id,
    changeType: change.changeType,
    explanation: change.explanation,
    explanationProvenance,
    verificationA: sideView(change.quoteA, change.verificationA, sourceA),
    verificationB: sideView(change.quoteB, change.verificationB, sourceB),
  };
}

// A side with no quote has no status either — never call toVerificationOutput with a null quote/result pair.
function sideView(quote: string | null, verification: ComparisonChangeResult["verificationA"], source: DocumentText) {
  if (quote === null || verification === null) return null;
  return toVerificationOutput(verification, { quote, ...source });
}
