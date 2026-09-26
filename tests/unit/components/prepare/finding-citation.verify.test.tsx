// Channel 7/8 (docs/ARCHITECTURE.md): a Prepare citation's OWN verification field
// (PrepareFindingRefOutput.verification) is never what VerificationBadge/QuoteBlock render — only
// the matching FindingOutput's real verification, looked up by id in documentFindings, ever reaches
// them (the badge-collision ruling). This is the display-side twin of prepare.ts's own server-side
// toFindingRef() mapping: even if a citation's own shape claimed "verified," a stale or fabricated
// claim can never surface as a real badge here.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { FindingCitation } from "@/components/prepare/finding-citation";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareFindingRefOutput } from "@/components/prepare/types";

const VERIFIED_FINDING: FindingOutput = {
  id: "11111111-1111-4111-8111-111111111111",
  category: "obligation",
  explanation: "You must pay rent monthly.",
  explanationProvenance: "ai_generated",
  lensExplanations: [],
  modelUsed: "gemini-2.5-flash",
  verification: {
    status: "verified",
    spanStart: 0,
    spanEnd: 20,
    spanText: "Rent is due monthly.",
    verifierVersion: "v1",
    textHash: "hash-a",
  },
};

const APPROXIMATE_FINDING: FindingOutput = {
  ...VERIFIED_FINDING,
  id: "22222222-2222-4222-8222-222222222222",
  verification: {
    status: "approximate",
    spanStart: 0,
    spanEnd: 20,
    spanText: "Rent is due monthly.",
    claimedQuote: "Rent is due each month.",
    verifierVersion: "v1",
    textHash: "hash-a",
  },
};

const MISSING_CLAUSE_FINDING: FindingOutput = {
  id: "33333333-3333-4333-8333-333333333333",
  category: "missing_clause",
  explanation: "No notice period clause found.",
  explanationProvenance: "checklist",
  lensExplanations: [],
  modelUsed: "none",
  verification: null,
};

function badgeCheckIcons(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("svg.lucide-badge-check");
}

function citationFor(finding: FindingOutput, claimedStatus: "verified" | "approximate" = "verified"): PrepareFindingRefOutput {
  return {
    id: finding.id,
    category: finding.category,
    verification: { status: claimedStatus, spanStart: 0, spanEnd: 20, spanText: "irrelevant claim", verifierVersion: "v1" },
  };
}

describe("FindingCitation — channel 7/8: only the real, looked-up finding ever drives a badge", () => {
  it("positive: a finding reference with a server verified status renders exactly one VerificationBadge", () => {
    const { container } = render(<FindingCitation citation={citationFor(VERIFIED_FINDING)} documentFindings={[VERIFIED_FINDING]} />);
    expect(container.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(1);
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("lookup correctness: the citation's OWN claimed status is ignored — the real documentFindings status wins", () => {
    // citationFor claims "verified," but the real, looked-up finding is only "approximate."
    const { container } = render(<FindingCitation citation={citationFor(APPROXIMATE_FINDING, "verified")} documentFindings={[APPROXIMATE_FINDING]} />);
    expect(screen.getByText("Approximate")).toBeInTheDocument();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(0);
  });

  it("a citation id with no match in documentFindings renders no badge and no quote — category only", () => {
    const { container } = render(<FindingCitation citation={citationFor(VERIFIED_FINDING)} documentFindings={[]} />);
    expect(container.querySelector('[data-slot="verification-badge"]')).not.toBeInTheDocument();
    expect(container.querySelector("blockquote")).not.toBeInTheDocument();
    expect(screen.getByText("Obligation")).toBeInTheDocument();
  });

  it("a missing_clause finding (verification: null) renders 'Flagged as possibly missing,' never a badge", () => {
    const { container } = render(
      <FindingCitation citation={{ id: MISSING_CLAUSE_FINDING.id, category: "missing_clause", verification: null }} documentFindings={[MISSING_CLAUSE_FINDING]} />,
    );
    expect(screen.getByText("Flagged as possibly missing")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="verification-badge"]')).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<FindingCitation citation={citationFor(VERIFIED_FINDING)} documentFindings={[VERIFIED_FINDING]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
