// The storage-integrity seam itself (the "approximate never upgrades on reopen" gate,
// at unit level): quoteTextForStorage/toGuestThreadCitation must never let an approximate/not_found
// citation's stored text be its own real spanText — that spanText would itself re-verify as
// "verified" if resent, silently upgrading the badge on reopen.

import { describe, expect, it } from "vitest";
import type { VerificationOutput } from "@/shared/contracts/common";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import {
  quoteTextForStorage,
  toGuestThreadCitation,
  toVerifyBatchRequestCitation,
  UNLINKED_SOURCE_DOCUMENT_ID,
} from "@/lib/guest-threads/citation";

const VERIFIED: VerificationOutput = {
  status: "verified",
  spanStart: 10,
  spanEnd: 40,
  spanText: "the notice period is 30 days",
  verifierVersion: "v1",
  textHash: "hash-a",
};

// A real approximate result: spanText is the actual (different) matched span, claimedQuote is the
// model's own unmatched claim — exactly the shape that would "verify" if its spanText were resent.
const APPROXIMATE: VerificationOutput = {
  status: "approximate",
  spanStart: 10,
  spanEnd: 40,
  spanText: "the notice period is thirty days",
  claimedQuote: "the notice period is 30-days approx",
  verifierVersion: "v1",
  textHash: "hash-a",
};

const NOT_FOUND: VerificationOutput = {
  status: "not_found",
  spanStart: null,
  spanEnd: null,
  spanText: null,
  claimedQuote: "a quote the document never contained",
  verifierVersion: "v1",
  textHash: "hash-a",
};

function citationOutput(verification: VerificationOutput, sourceDocumentId: string | null = "doc-1"): AskCitationOutput {
  return { id: null, sourceDocumentId, inputMode: "text", verification };
}

describe("quoteTextForStorage", () => {
  it("verified: stores spanText (the only field it has)", () => {
    expect(quoteTextForStorage(VERIFIED)).toBe(VERIFIED.spanText);
  });

  it("approximate: stores claimedQuote, NEVER spanText, even though spanText also exists on this status", () => {
    expect(quoteTextForStorage(APPROXIMATE)).toBe(APPROXIMATE.claimedQuote);
    expect(quoteTextForStorage(APPROXIMATE)).not.toBe(APPROXIMATE.spanText);
  });

  it("not_found: stores claimedQuote (spanText is null on this status)", () => {
    expect(quoteTextForStorage(NOT_FOUND)).toBe(NOT_FOUND.claimedQuote);
  });
});

describe("toGuestThreadCitation — the one write path", () => {
  it("verified citation round-trips its cached status and spanText", () => {
    const stored = toGuestThreadCitation(citationOutput(VERIFIED));
    expect(stored).toEqual({
      quoteText: "the notice period is 30 days",
      sourceDocumentId: "doc-1",
      unverifiedCachedStatus: "cached_verified",
    });
  });

  it("approximate citation stores claimedQuote — the red-proof: a naive `spanText` write here would make this citation re-verify as verified on reopen", () => {
    const stored = toGuestThreadCitation(citationOutput(APPROXIMATE));
    expect(stored.quoteText).toBe(APPROXIMATE.claimedQuote);
    expect(stored.unverifiedCachedStatus).toBe("cached_approximate");

    // The actual storage-integrity property this whole module exists for: nothing recoverable from
    // the stored object can reconstruct the real (exact) spanText a naive implementation might have
    // stored instead.
    expect(stored.quoteText).not.toBe(APPROXIMATE.spanText);
  });

  it("not_found citation stores claimedQuote", () => {
    const stored = toGuestThreadCitation(citationOutput(NOT_FOUND));
    expect(stored.quoteText).toBe(NOT_FOUND.claimedQuote);
    expect(stored.unverifiedCachedStatus).toBe("cached_not_found");
  });

  it("an unlinked citation (sourceDocumentId null) stores the empty sentinel id, never null/undefined", () => {
    const stored = toGuestThreadCitation(citationOutput(NOT_FOUND, null));
    expect(stored.sourceDocumentId).toBe(UNLINKED_SOURCE_DOCUMENT_ID);
    expect(stored.sourceDocumentId).toBe("");
  });

  it("the stored object carries no status/verification/spanStart key at all — only GuestThreadCitation's own three fields", () => {
    const stored = toGuestThreadCitation(citationOutput(APPROXIMATE));
    expect(Object.keys(stored).sort()).toEqual(["quoteText", "sourceDocumentId", "unverifiedCachedStatus"]);
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain('"status"');
    expect(raw).not.toContain('"verification"');
    expect(raw).not.toContain('"spanStart"');
    expect(raw).not.toContain('"spanText"');
  });
});

describe("toVerifyBatchRequestCitation", () => {
  it("maps a stored citation to verify-batch's own {documentId, quote} shape", () => {
    const stored = toGuestThreadCitation(citationOutput(APPROXIMATE));
    expect(toVerifyBatchRequestCitation(stored)).toEqual({ documentId: "doc-1", quote: APPROXIMATE.claimedQuote });
  });
});
