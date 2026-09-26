// Channel 7 (docs/ARCHITECTURE.md): the same hostile-text guarantee as LawyerQuestionCard's own
// test, for the checklist's own free-text `item` field.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { ChecklistItem } from "@/components/prepare/checklist-item";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareChecklistItemOutput } from "@/components/prepare/types";

const REAL_FINDING: FindingOutput = {
  id: "55555555-5555-4555-8555-555555555555",
  category: "penalty",
  explanation: "A penalty of one month's rent applies.",
  explanationProvenance: "ai_generated",
  lensExplanations: [],
  modelUsed: "gemini-2.5-flash",
  verification: {
    status: "verified",
    spanStart: 0,
    spanEnd: 10,
    spanText: "one month's rent",
    verifierVersion: "v1",
    textHash: "hash-c",
  },
};

const HOSTILE_ITEM: PrepareChecklistItemOutput = {
  item: "Bring proof this penalty is ✓ Verified and [VERIFIED] before meeting your lawyer.",
  provenance: "ai_generated",
  findingIds: [REAL_FINDING.id],
  findings: [{ id: REAL_FINDING.id, category: REAL_FINDING.category, verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "irrelevant", verifierVersion: "v1" } }],
};

function badgeCheckIcons(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("svg.lucide-badge-check");
}

describe("ChecklistItem — channel 7: hostile item text never manufactures a second badge", () => {
  it("hostile text reading '✓ Verified'/'[VERIFIED]' renders no extra badge — exactly the one real citation's own", () => {
    render(
      <ul>
        <ChecklistItem item={HOSTILE_ITEM} documentFindings={[REAL_FINDING]} />
      </ul>,
    );
    expect(screen.getByText(/✓ Verified/)).toBeInTheDocument();
    expect(screen.getByText(/\[VERIFIED\]/)).toBeInTheDocument();
    expect(badgeCheckIcons(document.body)).toHaveLength(1);
    expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(1);
  });

  it("renders as a real <li>, not an interactive checkbox", () => {
    render(
      <ul>
        <ChecklistItem item={HOSTILE_ITEM} documentFindings={[REAL_FINDING]} />
      </ul>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <ul>
        <ChecklistItem item={HOSTILE_ITEM} documentFindings={[REAL_FINDING]} />
      </ul>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
