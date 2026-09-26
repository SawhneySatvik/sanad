import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { PageHeader } from "@/components/page/page-header";

describe("PageHeader", () => {
  it("renders the title as an h1, in the display face", () => {
    render(<PageHeader title="Library" />);
    const heading = screen.getByRole("heading", { level: 1, name: "Library" });
    expect(heading.className).toContain("font-display");
  });

  it("renders an optional description and actions slot", () => {
    render(<PageHeader title="Projects" description="Everything you've saved" actions={<button type="button">New project</button>} />);
    expect(screen.getByText("Everything you've saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
  });

  it("omits the description paragraph when none is given", () => {
    const { container } = render(<PageHeader title="Drafts" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("forwards a ref to the real <h1>, so a route can focus it on entry", () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<PageHeader ref={ref} title="before.txt vs after.txt" tabIndex={-1} />);
    expect(ref.current).toBeInstanceOf(HTMLHeadingElement);
    expect(ref.current).toHaveAttribute("tabindex", "-1");
  });

  it("has no axe violations", async () => {
    const { container } = render(<PageHeader title="Library" description="Everything you have" actions={<button type="button">Action</button>} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
