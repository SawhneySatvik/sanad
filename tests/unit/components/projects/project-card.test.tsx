import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ProjectCard } from "@/components/projects/project-card";
import { NextRouterStub } from "@tests/support/next-router-stub";

function renderCard(overrides: Partial<React.ComponentProps<typeof ProjectCard>> = {}) {
  return render(
    <NextRouterStub>
      <SidebarProvider>
        <ProjectCard
          id="proj-1"
          name="Apartment hunt"
          icon={null}
          updatedAtMs={Date.now() - 3_600_000}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          {...overrides}
        />
      </SidebarProvider>
    </NextRouterStub>,
  );
}

describe("ProjectCard", () => {
  it("renders no colour swatch regardless of a stored color value — icon renders in plain ink colour", () => {
    const { container } = renderCard();
    // No inline background-color/fill style tied to a hue anywhere in the card — the icon and its
    // wrapper only ever carry text-foreground/border-border, never a per-project colour.
    const styled = container.querySelectorAll("[style]");
    for (const el of styled) {
      expect(el.getAttribute("style") ?? "").not.toMatch(/background-color|fill:/);
    }
  });

  it("the stretched link's accessible name includes the project name and its Updated line, not the bare name alone", () => {
    renderCard({ name: "Apartment hunt" });
    const link = screen.getByRole("link", { name: /Apartment hunt, Updated/ });
    expect(link).toHaveAttribute("href", "/projects/proj-1");
  });

  it("falls back to FolderKanban for an unrecognised icon string", () => {
    const { container } = renderCard({ icon: "not-a-real-icon" });
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("ItemMenu's trigger is not a descendant of the stretched link", () => {
    renderCard();
    const link = screen.getByRole("link", { name: /Apartment hunt/ });
    const trigger = screen.getByRole("button", { name: "Actions for Apartment hunt" });
    expect(link.contains(trigger)).toBe(false);
    expect(trigger.contains(link)).toBe(false);
  });

  it("has no axe violations", async () => {
    const { container } = renderCard();
    expect(await axe(container)).toHaveNoViolations();
  });
});
