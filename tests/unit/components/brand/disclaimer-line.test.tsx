import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { DISCLAIMER_TEXT, DisclaimerLine } from "@/components/brand/disclaimer-line";

describe("DisclaimerLine", () => {
  it("renders the exact fixed sentence", () => {
    render(<DisclaimerLine />);
    expect(screen.getByText("Saboot explains documents. It isn't legal advice.")).toBeInTheDocument();
    expect(DISCLAIMER_TEXT).toBe("Saboot explains documents. It isn't legal advice.");
  });

  it("renders the same text for both variants — only the layout differs", () => {
    const composer = render(<DisclaimerLine variant="composer" />);
    expect(within(composer.container).getByText(DISCLAIMER_TEXT)).toBeInTheDocument();
    const footer = render(<DisclaimerLine variant="footer" />);
    expect(within(footer.container).getByText(DISCLAIMER_TEXT)).toBeInTheDocument();
  });

  it("is not a landmark", () => {
    render(<DisclaimerLine />);
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<DisclaimerLine />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
