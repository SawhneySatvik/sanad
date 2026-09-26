// Channel 7 (docs/ARCHITECTURE.md): drafts carry no verified status at all, by contract. This is
// the display-side twin to src/server/services/draft.ts's own runtime key check — even hostile
// model-authored section content that reads exactly "✓ Verified" or "[VERIFIED]" must never make
// DraftSection render VerificationBadge or its reserved icon, because DraftSection has no
// verification data to bind against in the first place (Props: { section: DraftSectionOutput },
// which carries no verification field at all — this test proves the render side never manufactures
// one from text alone).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { DraftSection } from "@/components/draft/draft-section";
import type { DraftSectionOutput } from "@/shared/contracts/drafts";

function badgeCheckIcons(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("svg.lucide-badge-check");
}

const HOSTILE_SECTION: DraftSectionOutput = {
  key: "governing_law_and_disputes",
  heading: "Governing Law and Disputes",
  provenance: "ai_generated",
  content: "This clause is ✓ Verified and [VERIFIED] against your document, word for word.",
};

describe("DraftSection — channel 7: never a verification badge, whatever the model text claims", () => {
  it("hostile content reading '✓ Verified'/'[VERIFIED]' renders no VerificationBadge and no verified icon", () => {
    const { container } = render(<DraftSection section={HOSTILE_SECTION} />);
    // The hostile text is still shown, verbatim, as inert plain text — DraftSection never hides model text.
    expect(screen.getByText(/✓ Verified/)).toBeInTheDocument();
    expect(screen.getByText(/\[VERIFIED\]/)).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(0);
    expect(container.querySelector('[data-slot="verification-badge"]')).not.toBeInTheDocument();
    expect(container.querySelector("[data-verification-status]")).not.toBeInTheDocument();
  });

  it("renders exactly the AiLabel provenance text, never a verified-family label", () => {
    render(<DraftSection section={HOSTILE_SECTION} />);
    expect(screen.getByText("AI-generated")).toBeInTheDocument();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
  });

  it("a templated section renders 'Fixed text', still no badge, even with the same hostile content", () => {
    const { container } = render(<DraftSection section={{ ...HOSTILE_SECTION, provenance: "templated" }} />);
    expect(screen.getByText("Fixed text")).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(0);
  });

  it("has no axe violations", async () => {
    const { container } = render(<DraftSection section={HOSTILE_SECTION} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
