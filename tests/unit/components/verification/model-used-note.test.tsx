import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { ModelUsedNote } from "@/components/verification/model-used-note";

describe("ModelUsedNote", () => {
  it("discloses the real model name, never a placeholder", () => {
    render(<ModelUsedNote modelUsed="gemini-2.5-flash" />);
    expect(screen.getByText("Answered by gemini-2.5-flash")).toBeInTheDocument();
  });

  it("without sampleId, shows no recorded-output disclosure", () => {
    render(<ModelUsedNote modelUsed="gemini-2.5-flash" />);
    expect(screen.queryByText(/recorded output/)).not.toBeInTheDocument();
  });

  it("with sampleId set, adds the recorded-output disclosure — modelUsed still names the real model", () => {
    render(<ModelUsedNote modelUsed="gemini-2.5-flash" sampleId="sample-lease" />);
    expect(screen.getByText("Answered by gemini-2.5-flash")).toBeInTheDocument();
    expect(screen.getByText(/recorded output/)).toBeInTheDocument();
  });

  it("uses native <details>/<summary>, no custom aria-expanded bookkeeping needed", () => {
    const { container } = render(<ModelUsedNote modelUsed="gemini-2.5-flash" sampleId="sample-lease" />);
    expect(container.querySelector("details")).toBeInTheDocument();
    expect(container.querySelector("summary")).toBeInTheDocument();
  });

  it("has no axe violations, with and without a sampleId", async () => {
    const a = render(<ModelUsedNote modelUsed="gemini-2.5-flash" />);
    expect(await axe(a.container)).toHaveNoViolations();
    const b = render(<ModelUsedNote modelUsed="gemini-2.5-flash" sampleId="sample-lease" />);
    expect(await axe(b.container)).toHaveNoViolations();
  });
});
