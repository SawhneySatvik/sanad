import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { GroundingDocumentPicker, optionLabel } from "@/components/draft/grounding-document-picker";

// This component owns no visible label of its own (draft-composer.tsx pairs it with its own
// <Label htmlFor>) — every render here wraps it the same way real usage does, or an isolated
// render would report a false "buttons must have discernible text" that real usage never has.
function withLabel(children: React.ReactElement) {
  return (
    <>
      <label htmlFor="picker">Document to respond to</label>
      {children}
    </>
  );
}

describe("GroundingDocumentPicker", () => {
  it("appends 'Still processing' for a pending document", () => {
    expect(optionLabel({ id: "1", title: "Lease.pdf", processingStatus: "pending" })).toBe("Lease.pdf — Still processing");
  });

  it("appends 'Couldn't be read' for an extraction_failed document", () => {
    expect(optionLabel({ id: "1", title: "Lease.pdf", processingStatus: "extraction_failed" })).toBe("Lease.pdf — Couldn't be read");
  });

  it("a ready document carries no status suffix", () => {
    expect(optionLabel({ id: "1", title: "Lease.pdf", processingStatus: "ready" })).toBe("Lease.pdf");
  });

  it("renders every option's status note in the open list", async () => {
    const user = userEvent.setup();
    render(
      withLabel(
        <GroundingDocumentPicker
          id="picker"
          options={[
            { id: "1", title: "Lease.pdf", processingStatus: "ready" },
            { id: "2", title: "Offer.pdf", processingStatus: "pending" },
          ]}
          value={null}
          onChange={vi.fn()}
        />,
      ),
    );
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Lease.pdf")).toBeInTheDocument();
    expect(screen.getByText("Offer.pdf — Still processing")).toBeInTheDocument();
  });

  it("is disabled with zero options", () => {
    render(withLabel(<GroundingDocumentPicker id="picker" options={[]} value={null} onChange={vi.fn()} />));
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      withLabel(<GroundingDocumentPicker id="picker" options={[{ id: "1", title: "Lease.pdf", processingStatus: "ready" }]} value="1" onChange={vi.fn()} />),
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
