import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { ChangeCard, type ComparisonChange } from "@/components/compare/change-card";

const BASE: ComparisonChange = {
  id: "c1",
  changeType: "changed",
  explanation: "The deposit changed.",
  explanationProvenance: "ai_generated",
  verificationA: { status: "verified", spanStart: 0, spanEnd: 4, spanText: "rent", verifierVersion: "v1", textHash: "hash-a" },
  verificationB: { status: "verified", spanStart: 0, spanEnd: 4, spanText: "cost", verifierVersion: "v1", textHash: "hash-b" },
};

describe("ChangeCard — no nested interactive content", () => {
  it("is an <article>, never a <button>, and none of its own buttons/links nests inside another interactive element", () => {
    const { container } = render(<ChangeCard change={BASE} active={false} onSelect={vi.fn()} openDocumentId="doc-b" />);
    const card = container.querySelector("article")!;
    expect(card).not.toBeNull();
    expect(card.tagName).toBe("ARTICLE");

    const interactiveDescendants = card.querySelectorAll("button, a");
    for (const el of Array.from(interactiveDescendants)) {
      expect(el.parentElement?.closest("button,a")).toBeNull();
    }
    // At least "Show this change" (button) and "Open in document" (link) are present as siblings.
    expect(interactiveDescendants.length).toBeGreaterThanOrEqual(2);
  });

  it("'changeType' is conveyed by icon + text, never colour alone — the label is always visible text", () => {
    render(<ChangeCard change={BASE} active={false} onSelect={vi.fn()} openDocumentId="doc-b" />);
    expect(screen.getByText("Changed")).toBeInTheDocument();
  });

  it("clicking 'Show this change' calls onSelect with the change id and the clicked element", () => {
    const onSelect = vi.fn();
    render(<ChangeCard change={BASE} active={false} onSelect={onSelect} openDocumentId="doc-b" />);
    screen.getByRole("button", { name: "Show this change" }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [id, element] = onSelect.mock.calls[0];
    expect(id).toBe("c1");
    expect(element).toBeInstanceOf(HTMLElement);
  });

  it("'Open in document' is a plain link to /documents/:openDocumentId, no query or fragment", () => {
    render(<ChangeCard change={BASE} active={false} onSelect={vi.fn()} openDocumentId="doc-b" />);
    const link = screen.getByRole("link", { name: "Open in document" });
    expect(link.getAttribute("href")).toBe("/documents/doc-b");
  });

  it("an added change with verificationA null shows 'Not present in Document A.', never the generic re-check copy", () => {
    const change: ComparisonChange = { ...BASE, changeType: "added", verificationA: null };
    render(<ChangeCard change={change} active={false} onSelect={vi.fn()} openDocumentId="doc-b" />);
    expect(screen.getByText("Not present in Document A.")).toBeInTheDocument();
  });

  it("a removed change with verificationB null shows 'Not present in Document B.'", () => {
    const change: ComparisonChange = { ...BASE, changeType: "removed", verificationB: null };
    render(<ChangeCard change={change} active={false} onSelect={vi.fn()} openDocumentId="doc-a" />);
    expect(screen.getByText("Not present in Document B.")).toBeInTheDocument();
  });

  it("a 'changed' change with a null side (re-verify couldn't rebind it) shows the distinct re-check copy, not 'Not present'", () => {
    const change: ComparisonChange = { ...BASE, verificationB: null };
    render(<ChangeCard change={change} active={false} onSelect={vi.fn()} openDocumentId="doc-b" />);
    expect(screen.getByText("Couldn't be re-checked against this document right now.")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<ChangeCard change={BASE} active={false} onSelect={vi.fn()} openDocumentId="doc-b" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
