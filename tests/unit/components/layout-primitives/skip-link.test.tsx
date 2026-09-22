import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { SkipLink } from "@/components/layout-primitives/skip-link";

describe("SkipLink", () => {
  it("links to the given target id", () => {
    render(<SkipLink targetId="main-content" />);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
  });

  it("is visually hidden until it receives focus", () => {
    render(<SkipLink targetId="main-content" />);
    expect(screen.getByRole("link")).toHaveClass("sr-only");
  });

  it("has no axe violations", async () => {
    const { container } = render(<SkipLink targetId="main-content" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
