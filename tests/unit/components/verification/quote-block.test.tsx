import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { QuoteBlock } from "@/components/verification/quote-block";
import type { VerificationOutput } from "@/shared/contracts/common";

const VERIFIED: VerificationOutput = { status: "verified", spanStart: 0, spanEnd: 4, spanText: "rent", verifierVersion: "v1", textHash: "hash" };
const APPROXIMATE: VerificationOutput = {
  status: "approximate",
  spanStart: 0,
  spanEnd: 4,
  spanText: "rent",
  claimedQuote: "the rent amount",
  verifierVersion: "v1",
  textHash: "hash",
};
const NOT_FOUND: VerificationOutput = {
  status: "not_found",
  spanStart: null,
  spanEnd: null,
  spanText: null,
  claimedQuote: "a fabricated quote",
  verifierVersion: "v1",
  textHash: "hash",
};

describe("QuoteBlock", () => {
  it("verified: shows spanText, no claimedQuote row at all", () => {
    render(<QuoteBlock verification={VERIFIED} />);
    expect(screen.getByText("rent")).toBeInTheDocument();
    expect(screen.queryByText(/claimed quote/i)).not.toBeInTheDocument();
  });

  it("approximate: shows spanText AND claimedQuote under its own explicit label — never hidden", () => {
    render(<QuoteBlock verification={APPROXIMATE} />);
    expect(screen.getByText("rent")).toBeInTheDocument();
    expect(screen.getByText(/The model's claimed quote/)).toBeInTheDocument();
    expect(screen.getByText("the rent amount")).toBeInTheDocument();
  });

  it("not_found: no spanText row (there is none), shows claimedQuote under 'Not found in your document' — never hidden", () => {
    render(<QuoteBlock verification={NOT_FOUND} />);
    expect(screen.getByText("Not found in your document:")).toBeInTheDocument();
    expect(screen.getByText("a fabricated quote")).toBeInTheDocument();
  });

  it("renders plain text only — a hostile claimedQuote is never interpreted as HTML", () => {
    const hostile: VerificationOutput = { ...NOT_FOUND, claimedQuote: "<img src=x onerror=alert(1)>" };
    const { container } = render(<QuoteBlock verification={hostile} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("has no axe violations for any of the three statuses", async () => {
    for (const verification of [VERIFIED, APPROXIMATE, NOT_FOUND]) {
      const { container, unmount } = render(<QuoteBlock verification={verification} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe("QuoteBlock — native_document (scanned) display, never a status change", () => {
  const SCANNED_EQUAL: VerificationOutput = {
    status: "approximate",
    spanStart: 0,
    spanEnd: 4,
    spanText: "rent",
    claimedQuote: "rent",
    verifierVersion: "v1",
    textHash: "hash",
  };

  it("native_document + claimedQuote === spanText: one line explaining the scan, never the duplicate 'claimed quote' line", () => {
    render(<QuoteBlock verification={SCANNED_EQUAL} inputMode="native_document" />);
    expect(screen.getByText("Read from a scanned image, so exact matches show as approximate.")).toBeInTheDocument();
    expect(screen.queryByText(/The model's claimed quote/)).not.toBeInTheDocument();
    // Display only — the badge still renders exactly what the server sent.
    expect(screen.getByText("Approximate")).toBeInTheDocument();
  });

  it("native_document but claimedQuote differs from spanText: the ordinary claimed-quote line still shows", () => {
    render(<QuoteBlock verification={APPROXIMATE} inputMode="native_document" />);
    expect(screen.getByText(/The model's claimed quote/)).toBeInTheDocument();
    expect(screen.queryByText("Read from a scanned image, so exact matches show as approximate.")).not.toBeInTheDocument();
  });

  it("text mode with an equal claimedQuote/spanText: the ordinary claimed-quote line still shows — the scan note is native_document-only", () => {
    render(<QuoteBlock verification={SCANNED_EQUAL} inputMode="text" />);
    expect(screen.getByText(/The model's claimed quote/)).toBeInTheDocument();
    expect(screen.queryByText("Read from a scanned image, so exact matches show as approximate.")).not.toBeInTheDocument();
  });

  it("inputMode omitted: behaves exactly like 'text' (never native_document's special-casing) — an unresolved text query is not evidence of a scan", () => {
    render(<QuoteBlock verification={SCANNED_EQUAL} />);
    expect(screen.getByText(/The model's claimed quote/)).toBeInTheDocument();
    expect(screen.queryByText("Read from a scanned image, so exact matches show as approximate.")).not.toBeInTheDocument();
  });
});

describe("QuoteBlock — bidi isolation on spanText (canonical_text is byte-exact, bidi controls included)", () => {
  const RLO = "‮";
  const HOSTILE_SPAN = `${RLO}txet nedih${RLO}`;

  it("verified: spanText's textContent is byte-exact and wrapped in an isolated <bdi>", () => {
    const verification: VerificationOutput = { ...VERIFIED, spanText: HOSTILE_SPAN };
    const { container } = render(<QuoteBlock verification={verification} />);
    const bdi = container.querySelector("bdi")!;
    expect(bdi).not.toBeNull();
    expect(bdi.textContent).toBe(HOSTILE_SPAN);
    expect(bdi.style.unicodeBidi).toBe("isolate");
  });

  it("approximate: spanText is isolated the same way, independent of claimedQuote (which is already sanitized server-side)", () => {
    const verification: VerificationOutput = { ...APPROXIMATE, spanText: HOSTILE_SPAN };
    const { container } = render(<QuoteBlock verification={verification} />);
    const bdi = container.querySelector("bdi")!;
    expect(bdi.textContent).toBe(HOSTILE_SPAN);
    expect(bdi.style.unicodeBidi).toBe("isolate");
  });
});
