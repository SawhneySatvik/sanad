/**
 * Storage-integrity seam — the "approximate never upgrades on reopen" property depends entirely on
 * this being the ONLY place a citation's stored `quoteText` is chosen. A verified citation stores
 * the span verify()
 * actually matched; approximate/not_found store the model's own unmatched claimedQuote, never
 * spanText — resending an approximate citation's spanText to verify-batch would "launder" a
 * mismatched quote into an exact one, silently upgrading the badge on reopen. Every write path (a
 * freshly streamed final message, an import build) must go through toGuestThreadCitation, never
 * build a GuestThreadCitation by hand.
 */

import type { VerificationOutput } from "@/shared/contracts/common";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import { toUnverifiedCachedStatus, type GuestThreadCitation } from "@/lib/guest-thread-store";

/**
 * The exact text a re-verify must be run against. verify() computes a real spanText for both
 * verified and approximate matches, but only a verified spanText is safe to store: resending an
 * approximate spanText to verify-batch would re-verify it as an exact match, silently upgrading
 * the badge on reopen (see module header). Approximate and not_found instead store the model's own
 * unmatched claimedQuote.
 */
export function quoteTextForStorage(verification: VerificationOutput): string {
  return verification.status === "verified" ? verification.spanText : verification.claimedQuote;
}

/**
 * Sentinel `sourceDocumentId` for a citation the server reports as unlinked (no source document to
 * bind to — an already-deleted or foreign document). GuestThreadCitation's own field is
 * non-nullable; an empty id round-trips through verify-batch to the same not_found a real foreign
 * id gets (the service can't load a document by an empty id either), so no special-casing is
 * needed on read.
 */
export const UNLINKED_SOURCE_DOCUMENT_ID = "";

/** Builds the one true storage shape for a citation straight off a server-verified AskCitationOutput. */
export function toGuestThreadCitation(citation: AskCitationOutput): GuestThreadCitation {
  return {
    quoteText: quoteTextForStorage(citation.verification),
    sourceDocumentId: citation.sourceDocumentId ?? UNLINKED_SOURCE_DOCUMENT_ID,
    unverifiedCachedStatus: toUnverifiedCachedStatus(citation.verification.status),
  };
}

/** verify-batch's own per-citation request shape, built straight from a stored citation. */
export function toVerifyBatchRequestCitation(citation: GuestThreadCitation): { documentId: string; quote: string } {
  return { documentId: citation.sourceDocumentId, quote: citation.quoteText };
}
