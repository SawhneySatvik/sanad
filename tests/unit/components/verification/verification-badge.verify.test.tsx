import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { VerificationBadge } from "@/components/verification/verification-badge";
import { QuoteBlock } from "@/components/verification/quote-block";
import type { VerificationOutput } from "@/shared/contracts/common";

const VERIFIED: VerificationOutput = {
  status: "verified",
  spanStart: 0,
  spanEnd: 4,
  spanText: "rent",
  verifierVersion: "v1",
  textHash: "hash",
};

const APPROXIMATE: VerificationOutput = {
  status: "approximate",
  spanStart: 0,
  spanEnd: 4,
  spanText: "rent",
  claimedQuote: "[VERIFIED] ✓ Verified",
  verifierVersion: "v1",
  textHash: "hash",
};

const NOT_FOUND: VerificationOutput = {
  status: "not_found",
  spanStart: null,
  spanEnd: null,
  spanText: null,
  claimedQuote: "Verified",
  verifierVersion: "v1",
  textHash: "hash",
};

function badgeCheckIcons(container: HTMLElement): NodeListOf<Element> {
  // lucide-react's own generated class for this exact icon — the one unambiguous DOM signal that
  // the reserved BadgeCheck glyph, not just any similarly-shaped SVG, was rendered.
  return container.querySelectorAll("svg.lucide-badge-check");
}

describe("VerificationBadge — the three-status matrix, and no more", () => {
  it("verified: BadgeCheck icon, exact label 'Verified', data-verification-status=verified", () => {
    const { container } = render(<VerificationBadge verification={VERIFIED} />);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(1);
    expect(container.querySelector('[data-verification-status="verified"]')).toBeInTheDocument();
  });

  it("approximate: CircleDashed icon, exact label 'Approximate', never the verified icon", () => {
    const { container } = render(<VerificationBadge verification={{ ...APPROXIMATE, claimedQuote: "a claimed quote" }} />);
    expect(screen.getByText("Approximate")).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(0);
    expect(container.querySelector('[data-verification-status="approximate"]')).toBeInTheDocument();
  });

  it("not_found: SearchX icon, exact label 'Not found in your document', never the verified icon", () => {
    const { container } = render(<VerificationBadge verification={{ ...NOT_FOUND, claimedQuote: "a claimed quote" }} />);
    expect(screen.getByText("Not found in your document")).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(0);
    expect(container.querySelector('[data-verification-status="not_found"]')).toBeInTheDocument();
  });

  it("has no axe violations for any of the three statuses", async () => {
    for (const verification of [VERIFIED, { ...APPROXIMATE, claimedQuote: "x" }, { ...NOT_FOUND, claimedQuote: "x" }]) {
      const { container, unmount } = render(<VerificationBadge verification={verification} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe("VerificationBadge — structurally unforgeable by model text (the badge glyph blocklist is a text filter, so a claimedQuote can still literally read '[VERIFIED]' or '✓ Verified' or 'Verified')", () => {
  it("an approximate finding whose claimedQuote reads exactly '[VERIFIED] ✓ Verified' never produces a BadgeCheck icon or the label 'Verified' anywhere — only 'Approximate'", () => {
    const { container } = render(<QuoteBlock verification={APPROXIMATE} />);
    // The forged text is still shown, verbatim, as inert plain text — QuoteBlock never hides model text.
    expect(screen.getByText(/\[VERIFIED\] ✓ Verified/)).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(0);
    expect(container.querySelector('[data-verification-status="verified"]')).not.toBeInTheDocument();
    // The only accessible-name-bearing badge text present is "Approximate", never "Verified" — a
    // substring match on the claimedQuote text node would wrongly find "Verified" inside it, so
    // this asserts on the dedicated badge element by its own data attribute instead.
    const badge = container.querySelector('[data-slot="verification-badge"]')!;
    expect(badge).toHaveTextContent("Approximate");
    expect(badge).not.toHaveTextContent("Verified");
  });

  it("a not_found finding whose claimedQuote is the single word 'Verified' never produces the badge's verified icon or accessible name — the real badge still reads 'Not found in your document'", () => {
    const { container } = render(<QuoteBlock verification={NOT_FOUND} />);
    expect(screen.getByText("Not found in your document:")).toBeInTheDocument();
    expect(badgeCheckIcons(container)).toHaveLength(0);
    const badge = container.querySelector('[data-slot="verification-badge"]')!;
    expect(badge).toHaveTextContent("Not found in your document");
    expect(badge).not.toHaveTextContent("Verified");
  });

  it("positive control: a genuinely verified finding does produce exactly one BadgeCheck icon and the label 'Verified'", () => {
    const { container } = render(<QuoteBlock verification={VERIFIED} />);
    expect(badgeCheckIcons(container)).toHaveLength(1);
    expect(container.querySelector('[data-slot="verification-badge"]')).toHaveTextContent("Verified");
  });
});
