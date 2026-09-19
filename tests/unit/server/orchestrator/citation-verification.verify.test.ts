import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertVerifyResultFor, verify } from "@/server/deterministic/verify";
import { verifyCitations } from "@/server/orchestrator/citation-verification";
import type { OrchestratorDocumentInput } from "@/server/orchestrator/types";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeDoc(id: string, canonicalText: string, overrides: Partial<OrchestratorDocumentInput> = {}): OrchestratorDocumentInput {
  return {
    id,
    canonicalText,
    canonicalTextHash: sha256(canonicalText),
    inputMode: "text",
    ...overrides,
  };
}

// Span/display binding: every "verified"/"approximate" citation's span must slice the SAME
// document text back to exactly the quote — never trust the span number alone without checking
// what it actually points at.
function assertSpanMatchesQuote(citation: { status: string; spanStart: number | null; spanEnd: number | null; quote: string }, canonicalText: string): void {
  expect(citation.spanStart).not.toBeNull();
  expect(citation.spanEnd).not.toBeNull();
  expect(canonicalText.slice(citation.spanStart!, citation.spanEnd!)).toBe(citation.quote);
}

describe("verifyCitations", () => {
  const docText = "The notice period is 30 days from the date of this agreement.";
  const doc = makeDoc("doc-1", docText);

  it("a verbatim citation verifies, and its span slices the document back to exactly the quote", () => {
    const [result] = verifyCitations([{ quote: "30 days", sourceDocumentId: "doc-1" }], [doc]);
    expect(result.status).toBe("verified");
    assertSpanMatchesQuote(result, docText);
  });

  it("a fabricated citation returns not_found", () => {
    const [result] = verifyCitations([{ quote: "the fee is fully refundable", sourceDocumentId: "doc-1" }], [doc]);
    expect(result).toMatchObject({ status: "not_found", spanStart: null, spanEnd: null });
  });

  it("a citation to an unknown document id is DROPPED, not passed through with any status", () => {
    const results = verifyCitations([{ quote: "30 days", sourceDocumentId: "doc-does-not-exist" }], [doc]);
    expect(results).toEqual([]);
  });

  it("a citation whose sourceDocumentId is a non-UUID model-written string is DROPPED", () => {
    const results = verifyCitations([{ quote: "30 days", sourceDocumentId: "the lease agreement" }], [doc]);
    expect(results).toEqual([]);
  });

  it("a citation whose sourceDocumentId is a real (foreign) UUID not among the supplied documents is DROPPED, never linked", () => {
    const foreignUuid = "3f6f56b2-6e34-4c1d-9a3e-8f2b1a7c9d10";
    const results = verifyCitations([{ quote: "30 days", sourceDocumentId: foreignUuid }], [doc]);
    expect(results).toEqual([]);
    expect(results.some((r) => r.sourceDocumentId === foreignUuid)).toBe(false);
  });

  it("groups citations by document, preserves original order/per-quote correctness for known documents, and drops the unknown one", () => {
    const docB = makeDoc("doc-2", "The security deposit is refundable within 30 days.");
    const citations = [
      { quote: "30 days", sourceDocumentId: "doc-1" }, // verified, doc-1
      { quote: "not real text", sourceDocumentId: "doc-2" }, // not_found, doc-2
      { quote: "security deposit", sourceDocumentId: "doc-2" }, // verified, doc-2
      { quote: "doc-unknown quote", sourceDocumentId: "doc-3" }, // dropped, unknown doc
    ];
    const results = verifyCitations(citations, [doc, docB]);
    expect(results.map((r) => r.status)).toEqual(["verified", "not_found", "verified"]);
    expect(results.map((r) => r.sourceDocumentId)).toEqual(["doc-1", "doc-2", "doc-2"]);
    assertSpanMatchesQuote(results[0], docText);
    assertSpanMatchesQuote(results[2], docB.canonicalText);
  });

  it("caps quotes per document at MAX_QUOTES_PER_CALL by chunking, never throwing, and every span still matches its quote", () => {
    const longText = Array.from({ length: 60 }, (_, i) => `Clause number ${i} says something unique here.`).join(" ");
    const bigDoc = makeDoc("doc-big", longText);
    const citations = Array.from({ length: 60 }, (_, i) => ({
      quote: `Clause number ${i} says something unique here.`,
      sourceDocumentId: "doc-big",
    }));
    const results = verifyCitations(citations, [bigDoc]);
    expect(results).toHaveLength(60);
    expect(results.every((r) => r.status === "verified")).toBe(true);
    for (const result of results) assertSpanMatchesQuote(result, longText);
  });

  it("returns an empty array for an empty citations list", () => {
    expect(verifyCitations([], [doc])).toEqual([]);
  });

  // native_document rows (scanned/image PDFs, a model transcription, not independent evidence) can
  // never reach "verified" — verifyCitations must thread each document's OWN inputMode through to
  // verifyMany, not assume "text" for every document.
  it("a native_document document's verbatim citation caps at approximate, never verified", () => {
    const nativeDoc = makeDoc("doc-native", docText, { inputMode: "native_document" });
    const [result] = verifyCitations([{ quote: "30 days", sourceDocumentId: "doc-native" }], [nativeDoc]);
    expect(result.status).toBe("approximate");
    assertSpanMatchesQuote(result, docText);
  });

  // assertVerifyResultFor requires the expected inputMode and throws on a mismatch — a VerifyResult
  // computed with "text" can't be bound to a document whose row says "native_document" (or vice
  // versa). Pinned directly against the real (imported, not mocked) verify()/assertVerifyResultFor.
  it("assertVerifyResultFor rejects a VerifyResult computed with a different inputMode than expected", () => {
    const result = verify({ quote: "30 days", canonicalText: docText, inputMode: "text" });
    expect(() =>
      assertVerifyResultFor(result, {
        quote: "30 days",
        canonicalTextHash: result.canonicalTextHash,
        inputMode: "native_document",
      }),
    ).toThrow();
    // The matching inputMode does NOT throw — proves the check is genuinely comparing values,
    // not just always throwing.
    expect(() =>
      assertVerifyResultFor(result, { quote: "30 days", canonicalTextHash: result.canonicalTextHash, inputMode: "text" }),
    ).not.toThrow();
  });
});
