import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { AiLabel } from "@/components/verification/ai-label";
import { GENERAL_MODE_LABEL } from "@/shared/contracts/threads";

describe("AiLabel", () => {
  it('ai_generated reads exactly "AI-generated"', () => {
    render(<AiLabel provenance="ai_generated" />);
    expect(screen.getByText("AI-generated")).toBeInTheDocument();
  });

  it('templated reads exactly "Fixed text"', () => {
    render(<AiLabel provenance="templated" />);
    expect(screen.getByText("Fixed text")).toBeInTheDocument();
  });

  it("general mode renders the fixed GENERAL_MODE_LABEL constant, never a placeholder string", () => {
    render(<AiLabel generalModeLabel={GENERAL_MODE_LABEL} />);
    expect(screen.getByText(GENERAL_MODE_LABEL)).toBeInTheDocument();
  });

  it("never carries the not-legal-advice line — that is DisclaimerLine's job", () => {
    render(<AiLabel provenance="ai_generated" />);
    expect(screen.queryByText(/legal advice/i)).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(<AiLabel provenance="ai_generated" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
