// comparisonView over real verify() output (never mocked) — spanText is the canonical slice of
// THAT side's own document, and a verification computed against the wrong side's document text is
// refused rather than shown, never displayed as if it were the requested side's.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractDocument } from "@/server/deterministic/extract";
import { verify } from "@/server/deterministic/verify";
import type { ComparisonResult } from "@/server/services/compare";
import { LEASE } from "@tests/support/services/understand";
import { comparisonView } from "@/server/http/views/comparison-view";

const NDA_PARTY = "Northwind Consulting LLP";

interface Text {
  canonicalText: string;
  canonicalTextHash: string;
  inputMode: "text";
}

async function canonical(pastedText: string): Promise<Text> {
  const extracted = await extractDocument({ pastedText });
  if (extracted.kind !== "extracted") throw new Error("fixture did not extract");
  return { canonicalText: extracted.canonicalText, canonicalTextHash: extracted.canonicalTextHash, inputMode: "text" };
}

let lease: Text; // documentA's own canonical text
let nda: Text; // documentB's own canonical text — a genuinely different document

beforeAll(async () => {
  const fixtures = path.join(process.cwd(), "tests", "fixtures", "documents");
  lease = await canonical(await readFile(path.join(fixtures, "leave_and_license.txt"), "utf8"));
  nda = await canonical(await readFile(path.join(fixtures, "nda.txt"), "utf8"));
});

function document(text: Text, id: string) {
  return { id, canonicalText: text.canonicalText, canonicalTextHash: text.canonicalTextHash, inputMode: text.inputMode };
}

// A "changed" clause with a real, independently-verifiable quote on EACH side, bound to that side's
// own document — this is the shape comparisonView must wire correctly.
function twoSidedResult(): ComparisonResult {
  return {
    comparison: {
      id: "0a0a0a0a-0000-4000-8000-00000000000a",
      documentAId: "0b0b0b0b-0000-4000-8000-00000000000b",
      documentBId: "0c0c0c0c-0000-4000-8000-00000000000c",
      modelUsed: "fake-model",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      expiresAt: null,
    },
    documentA: document(lease, "0b0b0b0b-0000-4000-8000-00000000000b"),
    documentB: document(nda, "0c0c0c0c-0000-4000-8000-00000000000c"),
    changes: [
      {
        id: "c1",
        changeType: "changed",
        explanation: "The fee changed.",
        explanationProvenance: "ai_generated",
        quoteA: LEASE.licenseFee,
        quoteB: NDA_PARTY,
        verificationA: verify({ quote: LEASE.licenseFee, canonicalText: lease.canonicalText, inputMode: "text" }),
        verificationB: verify({ quote: NDA_PARTY, canonicalText: nda.canonicalText, inputMode: "text" }),
      },
      {
        id: "c2",
        changeType: "added",
        explanation: "A new clause.",
        explanationProvenance: "ai_generated",
        quoteA: null,
        quoteB: null,
        verificationA: null,
        verificationB: null,
      },
    ],
    // Only the fields comparisonView reads exist above; live validation's own instrumentation field.
  } as unknown as ComparisonResult;
}

describe("comparisonView", () => {
  it("each side's spanText is the canonical slice of THAT side's own document", () => {
    const view = comparisonView(twoSidedResult());
    const a = view.changes[0].verificationA;
    const b = view.changes[0].verificationB;
    expect(a?.status).toBe("verified");
    expect(b?.status).toBe("verified");
    if (a?.status !== "verified" || b?.status !== "verified") return;
    expect(a.spanText).toBe(lease.canonicalText.slice(a.spanStart, a.spanEnd));
    expect(a.spanText).toBe(LEASE.licenseFee);
    expect(b.spanText).toBe(nda.canonicalText.slice(b.spanStart, b.spanEnd));
    expect(b.spanText).toBe(NDA_PARTY);
  });

  it("a side with no quote carries no verification on the wire, and there is no quoteA/quoteB field at all", () => {
    const view = comparisonView(twoSidedResult());
    expect(view.changes[1]).toEqual({
      id: "c2",
      changeType: "added",
      explanation: "A new clause.",
      explanationProvenance: "ai_generated",
      verificationA: null,
      verificationB: null,
    });
    expect(Object.keys(view.changes[1]).sort()).toEqual([
      "changeType",
      "explanation",
      "explanationProvenance",
      "id",
      "verificationA",
      "verificationB",
    ]);
  });

  it("explanationProvenance follows each change even when a model was used", () => {
    const result = twoSidedResult();
    result.changes[1].explanationProvenance = "templated";
    const view = comparisonView(result);
    expect(view.changes[0].explanationProvenance).toBe("ai_generated");
    expect(view.changes[1].explanationProvenance).toBe("templated");
  });

  it("the model's raw claimed quote never rides the wire — not even on the verified change", () => {
    // An untrimmed, whitespace-padded model quote that still verifies (verify() normalizes
    // whitespace) — quoteA/quoteB must not exist on the wire even here.
    const paddedQuote = "   Rs.     32,000/-   ";
    const result = twoSidedResult();
    result.changes[0] = {
      ...result.changes[0],
      quoteA: paddedQuote,
      verificationA: verify({ quote: paddedQuote, canonicalText: lease.canonicalText, inputMode: "text" }),
    };
    const view = comparisonView(result);
    expect(view.changes[0].verificationA?.status).toBe("verified");
    expect(Object.keys(view.changes[0]).sort()).toEqual([
      "changeType",
      "explanation",
      "explanationProvenance",
      "id",
      "verificationA",
      "verificationB",
    ]);
    expect(JSON.stringify(view)).not.toContain("32,000/-   ");
    expect(JSON.stringify(view)).not.toContain("     32,000");
  });

  it("passes comparison-level fields through unchanged", () => {
    const view = comparisonView(twoSidedResult());
    expect(view).toMatchObject({
      id: "0a0a0a0a-0000-4000-8000-00000000000a",
      documentAId: "0b0b0b0b-0000-4000-8000-00000000000b",
      documentBId: "0c0c0c0c-0000-4000-8000-00000000000c",
      modelUsed: "fake-model",
      expiresAt: null,
    });
  });

  it("refuses a verification computed against the OTHER side's document text (A/B swap)", () => {
    const broken = twoSidedResult();
    // verificationA was computed against nda's text, not lease's — exactly what an A/B swap bug
    // would produce (compare.ts calling verify() with the wrong document's canonicalText for a
    // side, or this mapper handing toVerificationOutput the wrong document as `source`).
    broken.changes[0].verificationA = verify({ quote: LEASE.licenseFee, canonicalText: nda.canonicalText, inputMode: "text" });
    expect(() => comparisonView(broken)).toThrow(/different quote or document/);
  });

  it("refuses a document with no canonical text (invariant guard, mirrors document-view.ts)", () => {
    const broken = twoSidedResult();
    broken.documentA = { ...broken.documentA, canonicalText: null } as unknown as ComparisonResult["documentA"];
    expect(() => comparisonView(broken)).toThrow(/no canonical text/);
  });
});
