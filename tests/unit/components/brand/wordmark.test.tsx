import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { Wordmark } from "@/components/brand/wordmark";

describe("Wordmark", () => {
  it("links to /chat with the accessible name 'Saboot, home'", () => {
    render(<Wordmark />);
    const link = screen.getByRole("link", { name: "Saboot, home" });
    expect(link).toHaveAttribute("href", "/chat");
  });

  it("shows 'Saboot' as visible text when expanded", () => {
    render(<Wordmark />);
    expect(screen.getByText("Saboot")).toBeInTheDocument();
  });

  it("keeps the same accessible name when collapsed to the icon-only mark", () => {
    render(<Wordmark collapsed />);
    expect(screen.getByRole("link", { name: "Saboot, home" })).toBeInTheDocument();
    expect(screen.queryByText("Saboot")).not.toBeInTheDocument();
  });

  it("never renders the collapsed mark as a filled brand-accent tile", () => {
    render(<Wordmark collapsed />);
    const mark = screen.getByText("S");
    expect(mark.className).not.toMatch(/\bbg-primary\b/);
    expect(mark.className).not.toMatch(/\btext-primary-foreground\b/);
    expect(mark.className).toMatch(/\bbg-foreground\b/);
    expect(mark.className).toMatch(/\btext-background\b/);
  });

  it("has no axe violations, expanded or collapsed", async () => {
    const expanded = render(<Wordmark />);
    expect(await axe(expanded.container)).toHaveNoViolations();
    const collapsed = render(<Wordmark collapsed />);
    expect(await axe(collapsed.container)).toHaveNoViolations();
  });
});
