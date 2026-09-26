import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { DraftComposer, canSubmitDraft, type DraftMode } from "@/components/draft/draft-composer";
import type { FromScratchDocumentTypeId } from "@/lib/copy/document-type-labels";
import type { GroundingOption } from "@/components/draft/grounding-document-picker";

// A controlled component needs a stateful harness to exercise like a real page would — DraftComposer
// itself owns no state at all (draft-new-client.tsx does), so this mirrors that split exactly.
function Harness({
  groundingOptions = [],
  groundingOptionsLoading = false,
  onSubmit = vi.fn(),
  offline = false,
}: {
  groundingOptions?: GroundingOption[];
  groundingOptionsLoading?: boolean;
  onSubmit?: (input: unknown) => void;
  offline?: boolean;
}) {
  const [mode, setMode] = useState<DraftMode>("unset");
  const [documentType, setDocumentType] = useState<FromScratchDocumentTypeId | null>(null);
  const [groundingDocumentId, setGroundingDocumentId] = useState<string | null>(null);
  const [userInstructions, setUserInstructions] = useState("");

  return (
    <DraftComposer
      mode={mode}
      onModeChange={(next) => {
        setMode(next);
        if (next === "from_scratch") setGroundingDocumentId(null);
        else setDocumentType(null);
      }}
      documentType={documentType}
      onDocumentTypeChange={setDocumentType}
      groundingDocumentId={groundingDocumentId}
      onGroundingDocumentIdChange={setGroundingDocumentId}
      groundingOptions={groundingOptions}
      groundingOptionsLoading={groundingOptionsLoading}
      userInstructions={userInstructions}
      onUserInstructionsChange={setUserInstructions}
      onSubmit={() =>
        onSubmit({ mode, documentType, groundingDocumentId, userInstructions })
      }
      submitting={false}
      offline={offline}
    />
  );
}

describe("DraftComposer — mode<->type pairing", () => {
  it("from-scratch mode never lists grounded_response, and lists exactly the five draftable types", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("radio", { name: "Start from scratch" }));
    await user.click(screen.getByLabelText("Document type"));
    const options = screen.getAllByRole("option").map((el) => el.textContent);
    expect(options).toHaveLength(5);
    expect(options).not.toContain("Grounded Response Draft");
    expect(options).toContain("Leave and License Agreement (Rental)");
  });

  it("grounded mode shows only the fixed 'Grounded Response Draft' label, never a live choice", async () => {
    const user = userEvent.setup();
    render(<Harness groundingOptions={[{ id: "doc-1", title: "Lease.pdf", processingStatus: "ready" }]} />);
    await user.click(screen.getByRole("radio", { name: "Respond to a document you have" }));
    // Scoped to the trigger itself, not a bare getByText — Radix Select also mirrors every option
    // into a visually-hidden native <select> for form compatibility, which would otherwise double
    // this exact text.
    const groundedTypeTrigger = screen.getByLabelText("Document type");
    expect(within(groundedTypeTrigger).getByText("Grounded Response Draft")).toBeInTheDocument();
    // The fixed type Select is disabled — never an interactive alternative in this mode.
    expect(groundedTypeTrigger).toBeDisabled();
  });

  it("switching from grounded back to from-scratch clears groundingDocumentId, never submitting a stale cross-mode value", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness groundingOptions={[{ id: "doc-1", title: "Lease.pdf", processingStatus: "ready" }]} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("radio", { name: "Respond to a document you have" }));
    await user.click(screen.getByRole("combobox", { name: "Document to respond to" }));
    // role="option", not getByText: Radix Select mirrors every option into a hidden native <select>
    // too, which a plain text query would also match.
    await user.click(screen.getByRole("option", { name: "Lease.pdf" }));

    await user.click(screen.getByRole("radio", { name: "Start from scratch" }));
    await user.click(screen.getByLabelText("Document type"));
    await user.click(screen.getByRole("option", { name: "Non-Disclosure Agreement" }));
    await user.type(screen.getByLabelText(/what do you want this draft to say/i), "some instructions");
    await user.click(screen.getByRole("button", { name: "Draft" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "from_scratch", documentType: "nda", groundingDocumentId: null }),
    );
  });

  it("submitting with zero documents in grounded mode is impossible — the empty note shows and Draft stays disabled", async () => {
    const user = userEvent.setup();
    render(<Harness groundingOptions={[]} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Respond to a document you have" }));
    await user.type(screen.getByLabelText(/what do you want this draft to say/i), "some instructions");
    expect(screen.getByText(/you don't have any documents yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft" })).toBeDisabled();
  });

  it("has no axe violations in either mode", async () => {
    const { container, rerender } = render(<Harness />);
    expect(await axe(container)).toHaveNoViolations();
    rerender(<Harness groundingOptions={[{ id: "doc-1", title: "Lease.pdf", processingStatus: "ready" }]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("canSubmitDraft — the 4000-character cap disables submit, never truncates", () => {
  it("blank instructions never submit", () => {
    expect(
      canSubmitDraft({ mode: "from_scratch", documentType: "nda", groundingDocumentId: null, groundingOptions: [], userInstructions: "   ", offline: false, submitting: false }),
    ).toBe(false);
  });

  it("exactly 4000 characters is still submittable", () => {
    expect(
      canSubmitDraft({
        mode: "from_scratch",
        documentType: "nda",
        groundingDocumentId: null,
        groundingOptions: [],
        userInstructions: "a".repeat(4000),
        offline: false,
        submitting: false,
      }),
    ).toBe(true);
  });

  it("4001 characters disables submit — the text itself is never truncated by this function", () => {
    const overLimit = "a".repeat(4001);
    expect(
      canSubmitDraft({
        mode: "from_scratch",
        documentType: "nda",
        groundingDocumentId: null,
        groundingOptions: [],
        userInstructions: overLimit,
        offline: false,
        submitting: false,
      }),
    ).toBe(false);
    expect(overLimit).toHaveLength(4001); // this function never mutates/truncates its input
  });

  it("grounded mode with a not-ready selected document disables submit, even with a valid brief", () => {
    expect(
      canSubmitDraft({
        mode: "document_grounded",
        documentType: null,
        groundingDocumentId: "doc-1",
        groundingOptions: [{ id: "doc-1", title: "Lease.pdf", processingStatus: "pending" }],
        userInstructions: "reply asking for more time",
        offline: false,
        submitting: false,
      }),
    ).toBe(false);
  });

  it("grounded mode with a ready selected document enables submit", () => {
    expect(
      canSubmitDraft({
        mode: "document_grounded",
        documentType: null,
        groundingDocumentId: "doc-1",
        groundingOptions: [{ id: "doc-1", title: "Lease.pdf", processingStatus: "ready" }],
        userInstructions: "reply asking for more time",
        offline: false,
        submitting: false,
      }),
    ).toBe(true);
  });

  it("offline disables submit regardless of otherwise-valid fields", () => {
    expect(
      canSubmitDraft({ mode: "from_scratch", documentType: "nda", groundingDocumentId: null, groundingOptions: [], userInstructions: "valid brief", offline: true, submitting: false }),
    ).toBe(false);
  });
});
