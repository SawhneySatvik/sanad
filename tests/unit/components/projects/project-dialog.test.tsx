import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ProjectDialog } from "@/components/projects/project-dialog";

describe("ProjectDialog", () => {
  it("create mode: blocks an empty name with 'Give it a name.', no onSave call", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ProjectDialog open mode="create" onSave={onSave} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Give it a name.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rename mode never sends color/icon — only { name }", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ProjectDialog open mode="rename" initialName="Old name" initialIcon="House" onSave={onSave} onCancel={vi.fn()} />);
    const field = screen.getByLabelText("Name");
    await user.clear(field);
    await user.type(field, "New name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ name: "New name" });
  });

  it("rename mode shows no icon picker at all", () => {
    render(<ProjectDialog open mode="rename" initialName="Old name" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("a 200-character existing name still renders in full, and Save stays blocked at 120", async () => {
    const user = userEvent.setup();
    const longName = "n".repeat(200);
    const onSave = vi.fn();
    render(<ProjectDialog open mode="rename" initialName={longName} onSave={onSave} onCancel={vi.fn()} />);
    const field = screen.getByLabelText("Name") as HTMLInputElement;
    expect(field.value).toHaveLength(200);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("create mode's icon picker is a radiogroup of 7 confirmed icons, one selectable at a time", async () => {
    const user = userEvent.setup();
    render(<ProjectDialog open mode="create" onSave={vi.fn()} onCancel={vi.fn()} />);
    const group = screen.getByRole("radiogroup", { name: "Icon" });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(7);
    await user.click(screen.getByRole("radio", { name: "House" }));
    expect(screen.getByRole("radio", { name: "House" })).toHaveAttribute("aria-checked", "true");
    void group;
  });

  it("has no axe violations in create mode", async () => {
    const { container } = render(<ProjectDialog open mode="create" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
