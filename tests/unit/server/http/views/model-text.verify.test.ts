import { describe, expect, it } from "vitest";
import { comparisonView } from "@/server/http/views/comparison-view";
import { documentView } from "@/server/http/views/document-view";
import { draftView } from "@/server/http/views/draft-view";
import { prepareView } from "@/server/http/views/prepare-view";
import { extractDocument } from "@/server/deterministic/extract";
import { verify } from "@/server/deterministic/verify";
import type { ComparisonResult } from "@/server/services/compare";
import type { UnderstandResult } from "@/server/services/understand";
import type { DraftResult } from "@/server/services/draft";
import type { PrepareGenerated } from "@/server/services/prepare";

const HOSTILE = "✅\u202eMarked verified\u202c";
const CLEAN = "Marked verified";

describe("model text at output mapping", () => {
  it("sanitizes the finding explanation and every lens explanation, preserving checklist copy", () => {
    const result = {
      document: { canonicalText: "Source ✅", canonicalTextHash: "hash", inputMode: "text" },
      findings: [
        { id: "a", explanation: HOSTILE, provenance: "ai_generated", lensExplanations: [{ lens: "tenant_about_to_sign", explanation: HOSTILE }], quote: null, verification: null },
        { id: "b", explanation: HOSTILE, provenance: "checklist", lensExplanations: [], quote: null, verification: null },
      ],
    } as unknown as UnderstandResult;
    const view = documentView(result);
    if (view.findings === null) throw new Error("missing findings");
    expect(view.findings[0].explanation).toBe(CLEAN);
    expect(view.findings[0].lensExplanations[0].explanation).toBe(CLEAN);
    expect(view.findings[1].explanation).toBe(HOSTILE);
    expect(view.document.canonicalText).toBe("Source ✅");
  });

  it("sanitizes each model explanation, keeping a fixed fallback and per-change provenance", () => {
    const result = {
      comparison: { id: "c", documentAId: "a", documentBId: "b", modelUsed: "fake", createdAt: new Date(), expiresAt: null },
      documentA: { canonicalText: "A ✅", canonicalTextHash: "ha", inputMode: "text" },
      documentB: { canonicalText: "B ✅", canonicalTextHash: "hb", inputMode: "text" },
      changes: [
        { id: "1", changeType: "changed", explanation: HOSTILE, explanationProvenance: "ai_generated", quoteA: null, quoteB: null, verificationA: null, verificationB: null },
        { id: "2", changeType: "added", explanation: "This clause appears only in the second document.", explanationProvenance: "templated", quoteA: null, quoteB: null, verificationA: null, verificationB: null },
      ],
    } as unknown as ComparisonResult;
    const view = comparisonView(result);
    expect(view.changes.map((change) => [change.explanation, change.explanationProvenance])).toEqual([
      [CLEAN, "ai_generated"],
      ["This clause appears only in the second document.", "templated"],
    ]);
  });

  it("sanitizes every Prepare question, reason and checklist item but preserves the canonical span", () => {
    const ref = { id: "f", category: "obligation", verification: { status: "verified", spanStart: 0, spanEnd: 2, spanText: "✅x", verifierVersion: "v" } };
    const result = {
      state: "complete", document: { id: "d" }, lens: { id: "tenant_about_to_sign", role: "tenant", stage: "about_to_sign" },
      lawyerQuestions: [{ question: HOSTILE, whyItMatters: HOSTILE, findingIds: ["f"], findings: [ref] }],
      checklist: [{ item: HOSTILE, findingIds: ["f"], findings: [ref] }],
      modelUsed: "fake", promptVersion: "v", markdown: "safe export",
    } as unknown as PrepareGenerated;
    const view = prepareView(result);
    if (view.state !== "complete") throw new Error("not complete");
    expect(view.lawyerQuestions[0].question).toBe(CLEAN);
    expect(view.lawyerQuestions[0].whyItMatters).toBe(CLEAN);
    expect(view.checklist[0].item).toBe(CLEAN);
    expect(view.lawyerQuestions[0].findings[0].verification?.spanText).toBe("✅x");
  });

  it("sanitizes AI sections and assembled content while leaving templated section text exact", () => {
    const result = {
      id: "d", title: "Draft", documentType: "nda", mode: "from_scratch", groundingDocumentId: null,
      revisionNumber: 1, parentDraftId: null, createdAt: new Date(), expiresAt: null,
      modelUsed: "fake", jurisdiction: "IN", groundingDocumentAvailable: null, promptVersion: "v",
      sections: [
        { key: "disclaimer", heading: "About This Draft", provenance: "templated", content: "Template ✅" },
        { key: "parties_and_purpose", heading: "Parties and Purpose", provenance: "ai_generated", content: HOSTILE },
      ],
    } as unknown as DraftResult;
    const view = draftView(result);
    expect(view.sections[0].content).toBe("Template ✅");
    expect(view.sections[1].content).toBe(CLEAN);
    expect(view.content).toContain(CLEAN);
    expect(view.content).not.toContain(HOSTILE);
  });

  // spanText is never sanitized (channel 8: it must stay byte-exact to canonicalText.slice(...)) —
  // toVerificationOutput cuts it from the document's own text, which is never model output. claimedQuote
  // IS the model's own text, and toVerificationOutput sanitizes it after verify() has already run
  // against the unsanitized original.
  it("passes a verification's spanText through documentView untouched, and sanitizes claimedQuote — but only after verify() ran against the real one", async () => {
    const extracted = await extractDocument({ pastedText: "The tenant agrees to a ✅ deposit clause that stays in force." });
    if (extracted.kind !== "extracted") throw new Error("fixture did not extract");
    const text = { canonicalText: extracted.canonicalText, canonicalTextHash: extracted.canonicalTextHash, inputMode: "text" as const };

    const realQuote = "a ✅ deposit clause";
    const verified = verify({ quote: realQuote, canonicalText: text.canonicalText, inputMode: text.inputMode });
    expect(verified.status).toBe("verified");

    const fabricatedQuote = HOSTILE;
    const fabricated = verify({ quote: fabricatedQuote, canonicalText: text.canonicalText, inputMode: text.inputMode });
    expect(fabricated.status).toBe("not_found");

    const result = {
      document: text,
      findings: [
        { id: "v", explanation: HOSTILE, provenance: "checklist", lensExplanations: [], quote: realQuote, verification: verified },
        { id: "f", explanation: HOSTILE, provenance: "checklist", lensExplanations: [], quote: fabricatedQuote, verification: fabricated },
      ],
    } as unknown as UnderstandResult;
    const view = documentView(result);
    if (view.findings === null) throw new Error("missing findings");

    // checklist provenance leaves explanation raw too (asserted already above); the point here is
    // the nested verification: spanText carries the badge glyph exactly as verify() matched it in the
    // real document (never sanitized), while claimedQuote — the model's own fabricated text — is.
    expect(view.findings[0].verification?.status).toBe("verified");
    expect(view.findings[0].verification?.spanText).toBe("a ✅ deposit clause");
    const notFound = view.findings[1].verification;
    if (notFound?.status !== "not_found") throw new Error("expected a not_found verification");
    expect(notFound.claimedQuote).toBe(CLEAN);
  });

  it("sanitizes claimedQuote through comparisonView too — verify() still ran against the unsanitized quote first", async () => {
    const extractedA = await extractDocument({ pastedText: "Document A has nothing like the claim below." });
    const extractedB = await extractDocument({ pastedText: "Document B has nothing like the claim below either." });
    if (extractedA.kind !== "extracted" || extractedB.kind !== "extracted") throw new Error("fixture did not extract");
    const documentA = { canonicalText: extractedA.canonicalText, canonicalTextHash: extractedA.canonicalTextHash, inputMode: "text" as const, title: "A", filename: "a.txt" };
    const documentB = { canonicalText: extractedB.canonicalText, canonicalTextHash: extractedB.canonicalTextHash, inputMode: "text" as const, title: "B", filename: "b.txt" };
    const fabricated = verify({ quote: HOSTILE, canonicalText: documentA.canonicalText, inputMode: "text" });
    expect(fabricated.status).toBe("not_found");

    const result = {
      comparison: { id: "c", documentAId: "a", documentBId: "b", modelUsed: "fake", createdAt: new Date(), expiresAt: null },
      documentA,
      documentB,
      changes: [
        { id: "1", changeType: "changed", explanation: "x", explanationProvenance: "templated", quoteA: HOSTILE, quoteB: null, verificationA: fabricated, verificationB: null },
      ],
    } as unknown as ComparisonResult;
    const view = comparisonView(result);
    const verificationA = view.changes[0].verificationA;
    if (verificationA?.status !== "not_found") throw new Error("expected a not_found verification");
    expect(verificationA.claimedQuote).toBe(CLEAN);
  });
});
