/**
 * The Understand service's result -> the documents contract's wire shape: each finding's
 * VerifyResult becomes a VerificationOutput bound to this document, the model's quote leaves the
 * top level of the finding, and each explanation carries its finding's provenance — model-written,
 * or a deterministic checklist gap. Everything else passes through for the contract to whitelist.
 */

import type { UnderstandFinding, UnderstandResult } from "@/server/services/understand";
import { toVerificationOutput, type VerifiedAgainst } from "../verification";

/** Maps an UnderstandResult to the wire shape. */
export function documentView(result: UnderstandResult) {
  if (result.findings === null) return result;
  const { canonicalText, canonicalTextHash, inputMode } = result.document;
  // Findings exist only for a ready document, which always has all three (a DB CHECK).
  if (canonicalText === null || canonicalTextHash === null || inputMode === null) {
    throw new Error("A document with findings has no canonical text.");
  }
  const text = { canonicalText, canonicalTextHash, inputMode };
  return { ...result, findings: result.findings.map((finding) => findingView(finding, text)) };
}

function findingView(finding: UnderstandFinding, text: Omit<VerifiedAgainst, "quote">) {
  const { quote, verification, lensExplanations, provenance, ...rest } = finding;
  return {
    ...rest,
    explanationProvenance: provenance,
    // Only model findings have per-lens explanations, so each is model-written.
    lensExplanations: lensExplanations.map((lens) => ({ ...lens, explanationProvenance: "ai_generated" as const })),
    // A finding has a verification exactly when it has a quote (a DB CHECK); a mismatch fails the
    // binding check rather than showing anything.
    verification: verification === null ? null : toVerificationOutput(verification, { quote: quote ?? "", ...text }),
  };
}
