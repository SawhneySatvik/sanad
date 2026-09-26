import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { RenameDialog } from "@/components/shell/rename-dialog";

describe("RenameDialog", () => {
  it("prefills the current title and focuses the field", () => {
    render(
      <RenameDialog open itemType="document" currentTitle="Lease.pdf" onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    const field = screen.getByLabelText("Name");
    expect(field).toHaveValue("Lease.pdf");
    expect(field).toHaveFocus();
  });

  it("calls onSave with the trimmed title on submit", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RenameDialog open itemType="document" currentTitle="Lease.pdf" onSave={onSave} onCancel={vi.fn()} />);

    const field = screen.getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "  New title  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("New title");
  });

  it("disables Save for an empty or over-length title", async () => {
    const user = userEvent.setup();
    render(<RenameDialog open itemType="document" currentTitle="Lease.pdf" onSave={vi.fn()} onCancel={vi.fn()} />);

    const field = screen.getByLabelText("Name");
    await user.clear(field);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(field, "x".repeat(121));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("calls onCancel from the Cancel button", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RenameDialog open itemType="document" currentTitle="Lease.pdf" onSave={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(<RenameDialog open={false} itemType="document" currentTitle="Lease.pdf" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("has no axe violations while open", async () => {
    const { container } = render(
      <RenameDialog open itemType="document" currentTitle="Lease.pdf" onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
