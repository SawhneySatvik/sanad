import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { CitationChip } from "@/components/verification/citation-chip";
import type { AskCitationOutput } from "@/shared/contracts/threads";

const CITATION: AskCitationOutput = {
  id: "cit-1",
  sourceDocumentId: "doc-1",
  inputMode: "text",
  verification: { status: "verified", spanStart: 0, spanEnd: 4, spanText: "rent", verifierVersion: "v1", textHash: "hash" },
};

describe("CitationChip", () => {
  it("renders the badge and the verification's own preview inside one chip button", () => {
    render(<CitationChip citation={CITATION} documentLabel="lease.pdf" />);
    expect(screen.getByRole("button", { name: "Jump to citation in lease.pdf, verified" })).toBeInTheDocument();
    expect(screen.getByText("rent")).toBeInTheDocument();
  });

  it("derives the preview from the citation's own verification — spanText for verified/approximate, claimedQuote for not_found — never from a host-supplied string", () => {
    const approximate: AskCitationOutput = {
      ...CITATION,
      verification: { status: "approximate", spanStart: 0, spanEnd: 5, spanText: "rent ", claimedQuote: "the monthly rent", verifierVersion: "v1", textHash: "hash" },
    };
    render(<CitationChip citation={approximate} documentLabel="lease.pdf" />);
    expect(screen.getByText("rent")).toBeInTheDocument();
    expect(screen.queryByText("the monthly rent")).not.toBeInTheDocument();

    const notFound: AskCitationOutput = {
      ...CITATION,
      verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "a fabricated quote", verifierVersion: "v1", textHash: "hash" },
    };
    render(<CitationChip citation={notFound} documentLabel="lease.pdf" />);
    expect(screen.getByText("a fabricated quote")).toBeInTheDocument();
  });

  it("the badge info affordance is a separate sibling button, never nested inside the chip button", () => {
    const { container } = render(<CitationChip citation={CITATION} documentLabel="lease.pdf" />);
    const chipButton = screen.getByRole("button", { name: "Jump to citation in lease.pdf, verified" });
    const infoButton = screen.getByRole("button", { name: "What this verification status means" });
    expect(chipButton).not.toBe(infoButton);
    expect(chipButton.contains(infoButton)).toBe(false);
    expect(infoButton.contains(chipButton)).toBe(false);
    // Both are real <button> elements, direct children of the same wrapping <span> — siblings, not
    // one nested inside the other's own DOM subtree.
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("clicking the chip calls onActivate; clicking the info button calls onShowInfo — independently", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onShowInfo = vi.fn();
    render(<CitationChip citation={CITATION} documentLabel="lease.pdf" onActivate={onActivate} onShowInfo={onShowInfo} />);

    await user.click(screen.getByRole("button", { name: "Jump to citation in lease.pdf, verified" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onShowInfo).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "What this verification status means" }));
    expect(onShowInfo).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("aria-label states the document and status for each of the three statuses", () => {
    const approximate: AskCitationOutput = {
      ...CITATION,
      verification: { status: "approximate", spanStart: 0, spanEnd: 4, spanText: "rent", claimedQuote: "rent", verifierVersion: "v1", textHash: "hash" },
    };
    const notFound: AskCitationOutput = {
      ...CITATION,
      verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "rent", verifierVersion: "v1", textHash: "hash" },
    };
    const a = render(<CitationChip citation={approximate} documentLabel="lease.pdf" />);
    expect(a.getByRole("button", { name: "Jump to citation in lease.pdf, approximate" })).toBeInTheDocument();
    const b = render(<CitationChip citation={notFound} documentLabel="lease.pdf" />);
    expect(b.getByRole("button", { name: "Jump to citation in lease.pdf, not found in your document" })).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<CitationChip citation={CITATION} documentLabel="lease.pdf" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
