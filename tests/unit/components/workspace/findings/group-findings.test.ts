import { describe, expect, it } from "vitest";
import { groupFindingsByCategory, CATEGORY_LABELS } from "@/components/workspace/findings/group-findings";
import { DOCUMENT_CATEGORIES } from "@/shared/contracts/vocabulary";
import type { FindingOutput } from "@/shared/contracts/documents";

function verifiedFinding(id: string, category: FindingOutput["category"], spanStart: number): FindingOutput {
  return {
    id,
    category,
    explanation: `explanation for ${id}`,
    explanationProvenance: "ai_generated",
    lensExplanations: [],
    verification: { status: "verified", spanStart, spanEnd: spanStart + 4, spanText: "rent", verifierVersion: "v1", textHash: "hash" },
    modelUsed: "gemini",
  };
}

function notFoundFinding(id: string, category: FindingOutput["category"]): FindingOutput {
  return {
    id,
    category,
    explanation: `explanation for ${id}`,
    explanationProvenance: "ai_generated",
    lensExplanations: [],
    verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "x", verifierVersion: "v1", textHash: "hash" },
    modelUsed: "gemini",
  };
}

function checklistFinding(id: string): FindingOutput {
  return {
    id,
    category: "missing_clause",
    explanation: "no notice clause found",
    explanationProvenance: "checklist",
    lensExplanations: [],
    verification: null,
    modelUsed: "none",
  };
}

describe("groupFindingsByCategory", () => {
  it("never invents a group for a category with zero findings", () => {
    const groups = groupFindingsByCategory([verifiedFinding("f1", "obligation", 0)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("obligation");
  });

  it("orders present groups by DOCUMENT_CATEGORIES' own fixed order, regardless of input order", () => {
    const findings = [verifiedFinding("f1", "missing_clause" as never, 0), verifiedFinding("f2", "penalty", 0), verifiedFinding("f3", "obligation", 0)];
    // missing_clause needs a real quote for this fixture's own sake; category typing allows it since FindingOutput.category is just the enum.
    const groups = groupFindingsByCategory(findings as FindingOutput[]);
    const order = groups.map((g) => g.category);
    const expectedOrder = DOCUMENT_CATEGORIES.filter((c) => order.includes(c));
    expect(order).toEqual(expectedOrder);
  });

  it("sorts within a group by ascending spanStart (document order) — never a ranking", () => {
    const findings = [verifiedFinding("late", "obligation", 100), verifiedFinding("early", "obligation", 5)];
    const groups = groupFindingsByCategory(findings);
    expect(groups[0].findings.map((f) => f.id)).toEqual(["early", "late"]);
  });

  it("an unspanned finding (not_found, or checklist) sorts after every spanned finding, in original order among themselves", () => {
    const notFound1 = notFoundFinding("nf1", "obligation");
    const notFound2 = notFoundFinding("nf2", "obligation");
    const spanned = verifiedFinding("spanned", "obligation", 50);
    const groups = groupFindingsByCategory([notFound1, spanned, notFound2]);
    expect(groups[0].findings.map((f) => f.id)).toEqual(["spanned", "nf1", "nf2"]);
  });

  it("a checklist finding (verification: null) sorts alongside not_found findings, after every spanned one", () => {
    const groups = groupFindingsByCategory([checklistFinding("c1"), verifiedFinding("spanned", "missing_clause", 10)]);
    expect(groups[0].findings.map((f) => f.id)).toEqual(["spanned", "c1"]);
  });

  it("CATEGORY_LABELS covers every DOCUMENT_CATEGORIES entry with a distinct label", () => {
    const labels = DOCUMENT_CATEGORIES.map((c) => CATEGORY_LABELS[c]);
    expect(new Set(labels).size).toBe(DOCUMENT_CATEGORIES.length);
  });
});
