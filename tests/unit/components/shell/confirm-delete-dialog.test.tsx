import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ConfirmDeleteDialog } from "@/components/shell/confirm-delete-dialog";

describe("ConfirmDeleteDialog", () => {
  it("focuses Cancel on open, never the destructive confirm button", async () => {
    render(<ConfirmDeleteDialog open itemType="thread" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("calls onConfirm when the destructive action is chosen", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDeleteDialog open itemType="thread" onConfirm={onConfirm} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel from the Cancel action", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDeleteDialog open itemType="thread" onConfirm={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a draft states 'All N revisions' from its own revisionCount, not a generic count", () => {
    render(<ConfirmDeleteDialog open itemType="draft" revisionCount={4} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/All 4 revisions/)).toBeInTheDocument();
  });

  it("a document's impact adds the affected-counts sentence and the chat-unavailable line", () => {
    render(
      <ConfirmDeleteDialog
        open
        itemType="document"
        impact={{ comparisons: 2, draftsUngrounded: 1, threadsUnlinked: 3 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 comparison\(s\), 1 draft\(s\) and 3 chat\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/Chats on this device that quote it will show it as unavailable\./)).toBeInTheDocument();
  });

  it("all_data confirms with the exact F8 label", () => {
    render(<ConfirmDeleteDialog open itemType="all_data" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Delete all my data" })).toBeInTheDocument();
  });

  it("an unassign variant confirms with 'Remove', never the destructive tone", () => {
    render(<ConfirmDeleteDialog open variant="unassign" itemType="document" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("an override description replaces the computed default verbatim", () => {
    render(
      <ConfirmDeleteDialog
        open
        itemType="all_data"
        description="This browser's guest session only."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("This browser's guest session only.")).toBeInTheDocument();
  });

  it("has no axe violations while open", async () => {
    const { container } = render(<ConfirmDeleteDialog open itemType="thread" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
