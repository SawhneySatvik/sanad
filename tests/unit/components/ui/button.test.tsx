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

  it("uses a 2px ring with a 2px offset — never the heavier 3px ring", () => {
    render(<Button>Click me</Button>);
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button.className).toMatch(/\bfocus-visible:ring-2\b/);
    expect(button.className).toMatch(/\bfocus-visible:ring-offset-2\b/);
    expect(button.className).not.toMatch(/\bfocus-visible:ring-3\b/);
  });
});

describe("Button — hover contrast", () => {
  it("uses the dedicated --primary-hover token, never the translucent primary/80 (measured below 4.5:1 in the light theme)", () => {
    render(<Button>Click me</Button>);
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button.className).toMatch(/\bhover:bg-primary-hover\b/);
    expect(button.className).not.toMatch(/hover:bg-primary\/\d/);
  });
});

describe("Button — touch target", () => {
  it("pads a coarse-pointer hit area to at least 44x44 without growing the visible control", () => {
    render(<Button size="icon-sm">Click me</Button>);
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button.className).toMatch(/\brelative\b/);
    expect(button.className).toMatch(/pointer-coarse:before:min-h-11/);
    expect(button.className).toMatch(/pointer-coarse:before:min-w-11/);
    // The visible size variant is untouched — only the pseudo-element hit area grows.
    expect(button.className).toMatch(/\bsize-7\b/);
  });
});
