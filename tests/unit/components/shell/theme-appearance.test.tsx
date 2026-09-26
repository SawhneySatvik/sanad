import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ThemeProvider } from "next-themes";
import { ThemeAppearance } from "@/components/shell/theme-appearance";

function renderAppearance() {
  return render(
    <ThemeProvider attribute="class" enableSystem>
      <ThemeAppearance />
    </ThemeProvider>,
  );
}

describe("ThemeAppearance", () => {
  it("exposes a labelled Appearance radio group with all three options", () => {
    renderAppearance();
    const group = screen.getByRole("radiogroup", { name: "Appearance" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System" })).toBeInTheDocument();
  });

  it("selecting Dark applies the .dark class to <html>, matching the sidebar's own ThemeToggle", async () => {
    const user = userEvent.setup();
    renderAppearance();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveClass("dark");
  });

  it("has no axe violations", async () => {
    const { container } = renderAppearance();
    expect(await axe(container)).toHaveNoViolations();
  });
});
