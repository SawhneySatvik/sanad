/**
 * VerifyResult -> the VerificationOutput every route sends. The one sanctioned way to put a
 * verification on the wire — every route group uses this, never its own mapping. It first proves
 * the result belongs to this quote and this document (quote, canonical-text hash and input mode all
 * match), so a result attached to the wrong finding or the wrong side of a comparison throws
 * instead of showing the wrong passage, then cuts spanText from the document's own canonical text.
 * claimedQuote is sanitized here, after verify() has already run against it — never before, since
 * verify() must match the model's own text, not a scrubbed copy of it.
 */

import type { InputMode } from "@/server/core/types";
import { sanitizeModelText } from "@/server/deterministic/sanitize/model-text";
import { assertVerifyResultFor, type VerifyResult } from "@/server/deterministic/verify";
import type { VerificationOutput } from "@/shared/contracts/common";

/**
 * The quote and document a VerifyResult is checked against; `canonicalText`/`canonicalTextHash`
 * must come from the same document row.
 */
export interface VerifiedAgainst {
  // The exact quote the result was computed for (the finding's or citation's stored quote).
  quote: string;
  canonicalText: string;
  canonicalTextHash: string;
  inputMode: InputMode;
}

/**
 * Binds a VerifyResult to its quote and document, then maps it to the wire shape, slicing spanText
 * from `source.canonicalText` itself.
 * @throws if the result was not computed for this exact quote/document/input mode.
 */
export function toVerificationOutput(result: VerifyResult, source: VerifiedAgainst): VerificationOutput {
  assertVerifyResultFor(result, {
    quote: source.quote,
    canonicalTextHash: source.canonicalTextHash,
    inputMode: source.inputMode,
  });
  const { verifierVersion } = result;
  const textHash = source.canonicalTextHash;
  if (result.status === "not_found") {
    return { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: sanitizeModelText(result.quote), verifierVersion, textHash };
  }
  const span = {
    spanStart: result.spanStart,
    spanEnd: result.spanEnd,
    spanText: source.canonicalText.slice(result.spanStart, result.spanEnd),
  };
  return result.status === "verified"
    ? { status: "verified", ...span, verifierVersion, textHash }
    : { status: "approximate", ...span, claimedQuote: sanitizeModelText(result.quote), verifierVersion, textHash };
}
