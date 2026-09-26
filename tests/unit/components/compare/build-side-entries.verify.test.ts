// Span/display binding — Compare's own UI-level chokepoint. buildSideEntries() is the one place a
// comparison's changes become one side's segmentDocumentText() input — every range in it already
// came from bindSpan(), keyed by that side's own verification.textHash. The key negative case this
// file exists to prove: two documents can share byte-identical text (and therefore an identical
// textHash) while being different documents — so the hash alone must never be what keeps a quote
// off the wrong side; the expected document id has to be the thing that actually decides it.

import { describe, expect, it } from "vitest";
import { bindSpan, type BindSpanTarget } from "@/lib/verification/bindSpan";
import { buildSideEntries } from "@/components/compare/build-side-entries";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";

type Change = ComparisonWithChangesOutput["changes"][number];

const DOC_A = "doc-a";
const DOC_B = "doc-b";

function comparisonOf(changes: Change[]): Pick<ComparisonWithChangesOutput, "documentAId" | "documentBId" | "changes"> {
  return { documentAId: DOC_A, documentBId: DOC_B, changes };
}

function changeWith(overrides: Partial<Change> = {}): Change {
  return {
    id: "c1",
    changeType: "changed",
    explanation: "x",
    explanationProvenance: "ai_generated",
    verificationA: null,
    verificationB: null,
    ...overrides,
  };
}

describe("buildSideEntries — Compare's own per-side bind chokepoint", () => {
  it("positive: a verified change binds on its own side, with tone 'default'", () => {
    const target: BindSpanTarget = { documentId: DOC_A, text: "The rent is due monthly.", textHash: "hash-a" };
    const change = changeWith({ verificationA: { status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "v1", textHash: "hash-a" } });
    const entries = buildSideEntries("A", comparisonOf([change]), target);
    expect(entries).toEqual([{ findingId: "c1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }]);
  });

  it("positive: an approximate change becomes tone 'approximate'", () => {
    const target: BindSpanTarget = { documentId: DOC_A, text: "The rent is due monthly.", textHash: "hash-a" };
    const change = changeWith({
      verificationA: { status: "approximate", spanStart: 4, spanEnd: 8, spanText: "rent", claimedQuote: "rent fee", verifierVersion: "v1", textHash: "hash-a" },
    });
    expect(buildSideEntries("A", comparisonOf([change]), target)[0].tone).toBe("approximate");
  });

  it("negative: a not_found verification contributes nothing (bindSpan itself returns null for not_found)", () => {
    const target: BindSpanTarget = { documentId: DOC_A, text: "The rent is due monthly.", textHash: "hash-a" };
    const change = changeWith({
      verificationA: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "x", verifierVersion: "v1", textHash: "hash-a" },
    });
    expect(buildSideEntries("A", comparisonOf([change]), target)).toEqual([]);
  });

  it("negative: a null verification (the clause is absent from this side) contributes nothing", () => {
    const target: BindSpanTarget = { documentId: DOC_A, text: "The rent is due monthly.", textHash: "hash-a" };
    expect(buildSideEntries("A", comparisonOf([changeWith()]), target)).toEqual([]);
  });

  it("negative: a stale textHash suppresses the entry", () => {
    const target: BindSpanTarget = { documentId: DOC_A, text: "The rent is due monthly.", textHash: "hash-a" };
    const change = changeWith({ verificationA: { status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "v1", textHash: "STALE" } });
    expect(buildSideEntries("A", comparisonOf([change]), target)).toEqual([]);
  });

  it("negative: side B never reads side A's verification, even when side B's own verification is null (documentId is the only discriminator once text is identical)", () => {
    const SHARED_TEXT = "The security deposit is Rs. 1,50,000 refundable at the end of the lease.";
    // Both documents' real, freshly-fetched text is byte-identical, so their real textHash is the
    // same value too (a hash of identical bytes) — the fixture this test needs: two DIFFERENT
    // documents sharing one textHash.
    const targetA: BindSpanTarget = { documentId: DOC_A, text: SHARED_TEXT, textHash: "shared-hash" };
    const targetB: BindSpanTarget = { documentId: DOC_B, text: SHARED_TEXT, textHash: "shared-hash" };
    const change = changeWith({
      verificationA: { status: "verified", spanStart: 24, spanEnd: 36, spanText: "Rs. 1,50,000", verifierVersion: "v1", textHash: "shared-hash" },
      verificationB: null,
    });
    const comparison = comparisonOf([change]);

    // Side A, given its own real document's text, binds — this is the genuinely valid case.
    expect(buildSideEntries("A", comparison, targetA)).toEqual([
      { findingId: "c1", range: { spanStart: 24, spanEnd: 36, spanText: "Rs. 1,50,000" }, tone: "default" },
    ]);
    // Side B, on its own real text, never even reads verificationA — it is null on side B by
    // construction, so there is nothing to bind, whatever side A's own status/hash says.
    expect(buildSideEntries("B", comparison, targetB)).toEqual([]);
  });

  it("negative, red-proven: side A's own verification, mis-wired against document B's target (same words, same offsets, different document), is rejected on the document-id check alone — never the hash, which the fixture makes agree either way", () => {
    const SHARED_TEXT = "The security deposit is Rs. 1,50,000 refundable at the end of the lease.";
    const targetB: BindSpanTarget = { documentId: DOC_B, text: SHARED_TEXT, textHash: "shared-hash" };
    const change = changeWith({
      verificationA: { status: "verified", spanStart: 24, spanEnd: 36, spanText: "Rs. 1,50,000", verifierVersion: "v1", textHash: "shared-hash" },
    });
    const comparison = comparisonOf([change]);

    // The mis-wiring: buildSideEntries("A", ...) always expects documentAId, but a future bug
    // hands it document B's own fetched text as the target.
    expect(buildSideEntries("A", comparison, targetB)).toEqual([]);

    // Red-proof / control: the exact same verification, against the exact same target, binds fine
    // the moment the expected document id is ALSO document B's — proving this fixture's hash and
    // offsets really do agree with document B's text, so the rejection above is the document-id
    // check earning its keep, not an accident of some other field disagreeing too.
    expect(bindSpan(change.verificationA!, targetB, { documentId: DOC_B })).not.toBeNull();
  });
});
