import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { Files } from "lucide-react";
import { EmptyState } from "@/components/feedback/empty-state";

describe("EmptyState", () => {
  it("renders a heading and body", () => {
    render(<EmptyState heading="Nothing here yet" body="Upload a document to get started." />);
    expect(screen.getByRole("heading", { name: "Nothing here yet" })).toBeInTheDocument();
    expect(screen.getByText("Upload a document to get started.")).toBeInTheDocument();
  });

  it("defaults to an h2, and honours headingLevel for a nested context", () => {
    const { rerender } = render(<EmptyState heading="Default level" />);
    expect(screen.getByRole("heading", { level: 2, name: "Default level" })).toBeInTheDocument();

    rerender(<EmptyState heading="Nested level" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Nested level" })).toBeInTheDocument();
  });

  it("renders an icon when given one", () => {
    const { container } = render(<EmptyState heading="Empty category" icon={Files} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders an AssetPlaceholder when given an asset, not an icon", () => {
    render(<EmptyState heading="Your library is empty" asset={{ id: "empty-library", ratio: "1 / 1" }} />);
    expect(screen.getByRole("img", { name: "Your library is empty" })).toBeInTheDocument();
  });

  it("sizes a non-square asset by its own aspect ratio, not a fixed square box — only width is set, so aspect-ratio governs the height", () => {
    render(<EmptyState heading="Nothing here yet" asset={{ id: "empty-drafts", ratio: "16 / 9" }} />);
    const el = screen.getByRole("img", { name: "Nothing here yet" });
    expect(el).toHaveStyle({ aspectRatio: "16 / 9", width: "240px" });
    expect(el.style.height).toBe("");
  });

  it("calls the action's onClick", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<EmptyState heading="Nothing here yet" action={{ label: "Upload a document", onClick }} />);
    await user.click(screen.getByRole("button", { name: "Upload a document" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders neither icon nor asset for a bare heading-only empty state", () => {
    const { container } = render(<EmptyState heading="Nothing here yet" />);
    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <EmptyState heading="Nothing here yet" body="Upload a document to get started." action={{ label: "Upload", onClick: () => {} }} icon={Files} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
