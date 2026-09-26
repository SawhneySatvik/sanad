import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { HighlightMark } from "@/components/document/highlight-mark";

describe("HighlightMark", () => {
  it("renders a real <mark>, never a styled <span>", () => {
    const { container } = render(<HighlightMark>rent</HighlightMark>);
    expect(container.querySelector("mark")).toBeInTheDocument();
  });

  it("a mark no finding has jumped to yet carries no tabindex at all", () => {
    const { container } = render(<HighlightMark>rent</HighlightMark>);
    expect(container.querySelector("mark")).not.toHaveAttribute("tabindex");
  });

  it("focusable renders tabindex=-1 — programmatically focusable, never a Tab stop", () => {
    const { container } = render(<HighlightMark focusable>rent</HighlightMark>);
    expect(container.querySelector("mark")).toHaveAttribute("tabindex", "-1");
  });

  it("tone=approximate uses a dashed underline — distinguishable by shape, not only by hue", () => {
    const { container } = render(<HighlightMark tone="approximate">rent</HighlightMark>);
    expect(container.querySelector("mark")).toHaveClass("border-dashed");
  });

  it("tone=default (the default) does not add the dashed class", () => {
    const { container } = render(<HighlightMark>rent</HighlightMark>);
    expect(container.querySelector("mark")).not.toHaveClass("border-dashed");
  });

  it("at rest (neither current nor active) a mark carries no background wash — only the underline", () => {
    const { container } = render(<HighlightMark>rent</HighlightMark>);
    const mark = container.querySelector("mark")!;
    expect(mark).not.toHaveClass("bg-mark-pulse");
    expect(mark).not.toHaveClass("border-b-2");
    // Explicit, not just "no wash class added": a bare <mark> is yellow in every browser's own UA
    // stylesheet, which jsdom doesn't apply, so a missing bg-transparent here would pass this suite
    // and still show a stray yellow wash on every real render.
    expect(mark).toHaveClass("bg-transparent");
  });

  it("current doubles the underline weight and washes the background — the persistent 'this is selected' style", () => {
    const { container } = render(<HighlightMark current>rent</HighlightMark>);
    const mark = container.querySelector("mark")!;
    expect(mark).toHaveClass("border-b-2");
    expect(mark).toHaveClass("bg-mark-pulse");
  });

  it("active adds a ring on top, distinguishing the just-landed flash from a merely-current mark", () => {
    const { container } = render(<HighlightMark current active>rent</HighlightMark>);
    const mark = container.querySelector("mark")!;
    expect(mark).toHaveClass("bg-mark-pulse");
    expect(mark).toHaveClass("ring-2");
  });

  it("carries unicode-bidi: isolate so an embedded bidi override cannot escape this mark's boundary", () => {
    const { container } = render(<HighlightMark>rent</HighlightMark>);
    expect((container.querySelector("mark") as HTMLElement).style.unicodeBidi).toBe("isolate");
  });

  it("never uses a --verified family token — HighlightMark is not the badge", () => {
    const { container } = render(<HighlightMark active tone="approximate">rent</HighlightMark>);
    expect(container.innerHTML).not.toMatch(/verified/i);
  });

  it("has no axe violations for either tone, current, active or not", async () => {
    for (const props of [{}, { tone: "approximate" as const }, { current: true }, { current: true, active: true }, { focusable: true }]) {
      const { container, unmount } = render(<HighlightMark {...props}>rent</HighlightMark>);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
