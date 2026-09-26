import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { DISCLAIMER_TEXT, DisclaimerLine } from "@/components/brand/disclaimer-line";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { LandingPage } from "@/components/marketing/landing-page";

function renderLanding() {
  return render(
    <NextRouterStub>
      <LandingPage />
    </NextRouterStub>,
  );
}

describe("LandingPage", () => {
  it("has exactly one h1, the ratified headline", () => {
    renderLanding();
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Read the document. See exactly where it says so.");
  });

  it("every CTA to /chat carries an href to /chat", () => {
    renderLanding();
    const openSaboot = screen.getByRole("link", { name: "Open Saboot" });
    const trySample = screen.getByRole("link", { name: "Try a sample" });
    expect(openSaboot).toHaveAttribute("href", "/chat");
    expect(trySample).toHaveAttribute("href", "/chat");
  });

  it("renders the disclaimer exactly once", () => {
    renderLanding();
    expect(screen.getAllByText(DISCLAIMER_TEXT)).toHaveLength(1);
  });

  // Red-proof: the same counting assertion, against a render known to duplicate the line, so a
  // regression that silently drops the second render below LandingPage's own real one only ever
  // caught by this file's own copy is still provably catchable, not just asserted to be zero here.
  it("red-proof: getAllByText(DISCLAIMER_TEXT) does detect a duplicate when one exists", () => {
    render(
      <>
        <DisclaimerLine variant="footer" />
        <DisclaimerLine variant="footer" />
      </>,
    );
    expect(screen.getAllByText(DISCLAIMER_TEXT)).toHaveLength(2);
  });

  it("has landmarks: header, main, footer", () => {
    renderLanding();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("axe: zero serious/critical violations", async () => {
    const { container } = renderLanding();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
