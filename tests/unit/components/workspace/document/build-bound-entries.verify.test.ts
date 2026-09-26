import { describe, expect, it } from "vitest";
import { buildBoundEntries } from "@/components/workspace/document/build-bound-entries";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { BindSpanTarget } from "@/lib/verification/bindSpan";

const DOC_ID = "doc-1";
const TEXT = "The rent is due monthly.";
const TARGET: BindSpanTarget = { documentId: DOC_ID, text: TEXT, textHash: "hash-1" };

function findingWith(verification: FindingOutput["verification"]): FindingOutput {
  return {
    id: "f1",
    category: "obligation",
    explanation: "x",
    explanationProvenance: "ai_generated",
    lensExplanations: [],
    verification,
    modelUsed: "gemini",
  };
}

describe("buildBoundEntries — the one place findings become segmentDocumentText's BoundEntry list", () => {
  it("a verified finding whose span matches the target text becomes a bound entry with tone 'default'", () => {
    const finding = findingWith({ status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "v1", textHash: "hash-1" });
    const entries = buildBoundEntries(DOC_ID, [finding], TARGET);
    expect(entries).toEqual([{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }]);
  });

  it("an approximate finding becomes tone 'approximate'", () => {
    const finding = findingWith({ status: "approximate", spanStart: 4, spanEnd: 8, spanText: "rent", claimedQuote: "rent fee", verifierVersion: "v1", textHash: "hash-1" });
    const entries = buildBoundEntries(DOC_ID, [finding], TARGET);
    expect(entries[0].tone).toBe("approximate");
  });

  it("a not_found finding contributes nothing (bindSpan itself returns null for not_found)", () => {
    const finding = findingWith({ status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "x", verifierVersion: "v1", textHash: "hash-1" });
    expect(buildBoundEntries(DOC_ID, [finding], TARGET)).toEqual([]);
  });

  it("a checklist finding (verification: null) contributes nothing", () => {
    expect(buildBoundEntries(DOC_ID, [findingWith(null)], TARGET)).toEqual([]);
  });

  it("a stale textHash suppresses the entry — red-proven: bypassing bindSpan would wrongly include it", () => {
    const finding = findingWith({ status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "v1", textHash: "STALE" });
    expect(buildBoundEntries(DOC_ID, [finding], TARGET)).toEqual([]);
  });

  it("a mismatched slice (spanText disagrees with target.text at those offsets) suppresses the entry", () => {
    const finding = findingWith({ status: "verified", spanStart: 4, spanEnd: 8, spanText: "WRONG", verifierVersion: "v1", textHash: "hash-1" });
    expect(buildBoundEntries(DOC_ID, [finding], TARGET)).toEqual([]);
  });

  it("a wrong-document pairing (this screen's own finding always names its own document, but the check still holds) suppresses the entry", () => {
    const finding = findingWith({ status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "v1", textHash: "hash-1" });
    expect(buildBoundEntries("a-different-document", [finding], TARGET)).toEqual([]);
  });

  it("extra synthetic entries (verifier demo, a clicked citation) are appended verbatim, already pre-bound by their own caller", () => {
    const extra = [{ findingId: "__verifier_demo__", range: { spanStart: 0, spanEnd: 3, spanText: "The" }, tone: "default" as const }];
    expect(buildBoundEntries(DOC_ID, [], TARGET, extra)).toEqual(extra);
  });
});
