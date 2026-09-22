import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { InlineNotice } from "@/components/feedback/inline-notice";

function renderNotice(children: React.ReactNode, tone?: "info" | "warning") {
  return render(
    <LiveRegionProvider>
      <InlineNotice tone={tone}>{children}</InlineNotice>
    </LiveRegionProvider>,
  );
}

describe("InlineNotice", () => {
  it("renders its children", () => {
    renderNotice("The document this draft was based on is no longer available.");
    expect(screen.getByText("The document this draft was based on is no longer available.")).toBeInTheDocument();
  });

  it("uses role=note, never role=alert (it is not one of the app's live regions)", () => {
    renderNotice("Sample document. Its analysis was recorded earlier.");
    const notice = screen.getByText("Sample document. Its analysis was recorded earlier.").closest("[role]");
    expect(notice).toHaveAttribute("role", "note");
  });

  it("mounts and unmounts with its own condition (no internal dismiss control)", () => {
    const { rerender, queryByText } = render(
      <LiveRegionProvider>
        <InlineNotice>only when true</InlineNotice>
      </LiveRegionProvider>,
    );
    expect(queryByText("only when true")).toBeInTheDocument();
    rerender(<LiveRegionProvider>{null}</LiveRegionProvider>);
    expect(queryByText("only when true")).not.toBeInTheDocument();
  });

  it("announces an array of text children joined together", async () => {
    renderNotice(["Sign in to ", "keep this."]);
    const liveNode = document.querySelector("[aria-live='polite']");
    await waitFor(() => expect(liveNode).toHaveTextContent("Sign in to keep this."));
  });

  it("recurses into an element child to announce its own text, not drop to empty", async () => {
    renderNotice(<strong>bold notice</strong>);
    const liveNode = document.querySelector("[aria-live='polite']");
    await waitFor(() => expect(liveNode).toHaveTextContent("bold notice"));
  });

  it("renders without crashing for a child with no text at all, and never announces a non-empty stray value", async () => {
    const { container } = renderNotice(<br />);
    const liveNode = document.querySelector("[aria-live='polite']");
    expect(container.querySelector("br")).toBeInTheDocument();
    await waitFor(() => expect(liveNode).toHaveTextContent(""));
  });

  it("carries no stray alert/status/log role or aria-live node wrapping its own role=note element — a wrapper outside the note element would double-announce the same text through two different live-region mechanisms", () => {
    const { container } = renderNotice("no double announcement here");
    const note = screen.getByText("no double announcement here").closest("[role]")!;
    expect(note).toHaveAttribute("role", "note");

    const forbidden = '[role="alert"], [role="status"], [role="log"], [aria-live]';
    expect(note.matches(forbidden)).toBe(false);
    expect(note.querySelectorAll(forbidden)).toHaveLength(0);

    // Walking the ancestor chain (not the whole container) is what keeps this from tripping on
    // LiveRegionProvider's own two standing aria-live siblings, which sit outside this chain.
    for (let ancestor = note.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
      expect(ancestor.matches(forbidden)).toBe(false);
    }
  });

  it("has no axe violations for either tone", async () => {
    const info = renderNotice("info tone text", "info");
    expect(await axe(info.container)).toHaveNoViolations();
    const warning = renderNotice("warning tone text", "warning");
    expect(await axe(warning.container)).toHaveNoViolations();
  });
});
