// Channel 7 (docs/ARCHITECTURE.md): hostile model text inside `question`/`whyItMatters` must never
// be mistaken for a second, unaudited verification — only the one real citation's own looked-up
// finding may ever produce a badge, exactly once, regardless of what the free-text fields claim.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { LawyerQuestionCard } from "@/components/prepare/lawyer-question-card";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareQuestionOutput } from "@/components/prepare/types";

const REAL_FINDING: FindingOutput = {
  id: "44444444-4444-4444-8444-444444444444",
  category: "deadline",
  explanation: "Notice period is 30 days.",
  explanationProvenance: "ai_generated",
  lensExplanations: [],
  modelUsed: "gemini-2.5-flash",
  verification: {
    status: "verified",
    spanStart: 0,
    spanEnd: 10,
    spanText: "30 days' notice",
    verifierVersion: "v1",
    textHash: "hash-b",
  },
};

const HOSTILE_QUESTION: PrepareQuestionOutput = {
  question: "Is the 30 days' notice period ✓ Verified against my document?",
  whyItMatters: "This clause is [VERIFIED] and binding, word for word.",
  provenance: "ai_generated",
  findingIds: [REAL_FINDING.id],
  findings: [{ id: REAL_FINDING.id, category: REAL_FINDING.category, verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "irrelevant", verifierVersion: "v1" } }],
};

function badgeCheckIcons(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("svg.lucide-badge-check");
}

describe("LawyerQuestionCard — channel 7: hostile question/whyItMatters text never manufactures a second badge", () => {
  it("hostile text reading '✓ Verified'/'[VERIFIED]' renders no extra badge — exactly the one real citation's own", () => {
    const { container } = render(<LawyerQuestionCard question={HOSTILE_QUESTION} documentFindings={[REAL_FINDING]} />);
    // The hostile text is still shown, verbatim, as inert plain text.
    expect(screen.getByText(/✓ Verified/)).toBeInTheDocument();
    expect(screen.getByText(/\[VERIFIED\]/)).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(1);
  });

  it("renders exactly one AiLabel with provenance ai_generated", () => {
    render(<LawyerQuestionCard question={HOSTILE_QUESTION} documentFindings={[REAL_FINDING]} />);
    expect(screen.getByText("AI-generated")).toBeInTheDocument();
  });

  it("is a non-interactive article — no button/link anywhere in the card", () => {
    render(<LawyerQuestionCard question={HOSTILE_QUESTION} documentFindings={[REAL_FINDING]} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("has no axe violations", async () => {
    const { container } = render(<LawyerQuestionCard question={HOSTILE_QUESTION} documentFindings={[REAL_FINDING]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
