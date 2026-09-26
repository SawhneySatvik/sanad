import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ItemMenu } from "@/components/shell/item-menu";
import { SidebarMenu, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar";

function renderMenu(overrides: Partial<Parameters<typeof ItemMenu>[0]> = {}) {
  const onRename = vi.fn();
  const onDelete = vi.fn();
  const onSaveToProject = overrides.onSaveToProject === undefined ? undefined : overrides.onSaveToProject;

  render(
    <SidebarProvider>
      <SidebarMenu>
        <SidebarMenuItem>
          <ItemMenu
            itemId="doc-1"
            itemType="document"
            label="lease.pdf"
            onRename={onRename}
            onDelete={onDelete}
            onSaveToProject={onSaveToProject}
            {...overrides}
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarProvider>,
  );

  return { onRename, onDelete };
}

describe("ItemMenu", () => {
  it("exposes a keyboard-operable trigger with a descriptive accessible name", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: "Actions for lease.pdf" })).toBeInTheDocument();
  });

  it("calls onRename when Rename is chosen", async () => {
    const user = userEvent.setup();
    const { onRename } = renderMenu();

    await user.click(screen.getByRole("button", { name: "Actions for lease.pdf" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("calls onDelete when Delete is chosen", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderMenu();

    await user.click(screen.getByRole("button", { name: "Actions for lease.pdf" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows Save to project only when the caller supplies onSaveToProject", async () => {
    const user = userEvent.setup();
    renderMenu({ onSaveToProject: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Actions for lease.pdf" }));
    expect(await screen.findByRole("menuitem", { name: "Save to project" })).toBeInTheDocument();
  });

  it("omits Save to project when the caller passes no callback at all", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Actions for lease.pdf" }));
    await screen.findByRole("menuitem", { name: "Delete" });
    expect(screen.queryByRole("menuitem", { name: "Save to project" })).not.toBeInTheDocument();
  });

  it("has no axe violations at rest", async () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <ItemMenu itemId="doc-1" itemType="document" label="lease.pdf" onRename={vi.fn()} onDelete={vi.fn()} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
