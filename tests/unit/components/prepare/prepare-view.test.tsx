import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { PrepareView } from "@/components/prepare/prepare-view";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareCompleteOutput } from "@/components/prepare/types";

const FINDING: FindingOutput = {
  id: "99999999-9999-4999-8999-999999999999",
  category: "obligation",
  explanation: "Pay rent monthly.",
  explanationProvenance: "ai_generated",
  lensExplanations: [],
  modelUsed: "gemini-2.5-flash",
  verification: {
    status: "verified",
    spanStart: 0,
    spanEnd: 10,
    spanText: "Rent is due on the 1st.",
    verifierVersion: "v1",
    textHash: "hash-f",
  },
};

const COMPLETE: PrepareCompleteOutput = {
  state: "complete",
  documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  lens: { id: "tenant_about_to_sign", role: "tenant", stage: "about_to_sign" },
  lawyerQuestions: [
    {
      question: "When is rent due?",
      whyItMatters: "Late payment may attract a penalty.",
      provenance: "ai_generated",
      findingIds: [FINDING.id],
      findings: [{ id: FINDING.id, category: FINDING.category, verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "irrelevant", verifierVersion: "v1" } }],
    },
  ],
  checklist: [
    {
      item: "Note the rent due date.",
      provenance: "ai_generated",
      findingIds: [FINDING.id],
      findings: [{ id: FINDING.id, category: FINDING.category, verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "irrelevant", verifierVersion: "v1" } }],
    },
  ],
  modelUsed: "gemini-2.5-flash",
  promptVersion: "prepare-v4",
  markdown: "# Prepare for your lawyer",
};

describe("PrepareView — complete", () => {
  it("renders the h1 from the shared lens-label table, both section headings with at least one card each, and ModelUsedNote", () => {
    render(<PrepareView prepare={COMPLETE} documentFindings={[FINDING]} onGoToDocument={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Prepared for: Tenant, before signing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Questions to ask your lawyer" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Before you sign / before you meet your lawyer" })).toBeInTheDocument();
    expect(screen.getByText("When is rent due?")).toBeInTheDocument();
    expect(screen.getByText("Note the rent due date.")).toBeInTheDocument();
    expect(screen.getByText(/Answered by gemini-2.5-flash/)).toBeInTheDocument();
  });

  it("every citation's badge equals the looked-up FindingOutput.verification status, never PrepareFindingRefOutput.verification directly", () => {
    render(<PrepareView prepare={COMPLETE} documentFindings={[FINDING]} onGoToDocument={vi.fn()} />);
    expect(screen.getAllByText("Verified")).toHaveLength(2); // one per card's citation
  });

  it("has no axe violations", async () => {
    const { container } = render(<PrepareView prepare={COMPLETE} documentFindings={[FINDING]} onGoToDocument={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("PrepareView — not_analyzed vs no_grounded_findings are visibly distinct", () => {
  it("not_analyzed shows its own heading, with a Go to document action", () => {
    const onGoToDocument = vi.fn();
    render(<PrepareView prepare={{ state: "not_analyzed", documentId: "x" }} documentFindings={[]} onGoToDocument={onGoToDocument} />);
    expect(screen.getByText("This document hasn't been analysed yet.")).toBeInTheDocument();
    screen.getByRole("button", { name: "Go to document" }).click();
    expect(onGoToDocument).toHaveBeenCalledTimes(1);
  });

  it("extraction_failed shows distinct copy from not_analyzed, with no 'Analyse now' affordance", () => {
    render(<PrepareView prepare={{ state: "not_analyzed", documentId: "x" }} documentFindings={[]} onGoToDocument={vi.fn()} extractionFailed />);
    expect(screen.getByText("We couldn't read this document.")).toBeInTheDocument();
    expect(screen.queryByText("This document hasn't been analysed yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /analyse now/i })).not.toBeInTheDocument();
  });

  it("no_grounded_findings shows its own distinct copy, never an empty 'complete' list", () => {
    render(<PrepareView prepare={{ state: "no_grounded_findings", documentId: "x" }} documentFindings={[]} onGoToDocument={vi.fn()} />);
    expect(screen.getByText("There's nothing verified enough in this document yet to prepare from.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Questions to ask your lawyer" })).not.toBeInTheDocument();
  });
});
