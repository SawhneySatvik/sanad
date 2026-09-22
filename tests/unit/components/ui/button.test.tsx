import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";

describe("Button — focus ring", () => {
  it("carries a solid focus-visible ring, never a translucent one (WCAG 2.2 SC 1.4.11's 3:1 non-text-contrast floor)", () => {
    render(<Button>Click me</Button>);
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button.className).toMatch(/(?:^|\s)focus-visible:ring-ring(?:\s|$)/);
    expect(button.className).not.toMatch(/focus-visible:ring-ring\/\d/);
  });
});
