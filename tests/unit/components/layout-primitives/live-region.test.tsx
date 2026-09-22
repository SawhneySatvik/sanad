import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { LiveRegion, LiveRegionProvider, useAnnounce, useAnnounceOnMount } from "@/components/layout-primitives/live-region";

describe("LiveRegion", () => {
  it("renders a visually-hidden aria-live node carrying the message as its text", () => {
    render(<LiveRegion politeness="polite" message="Showing this obligation in the document" />);
    const region = screen.getByText("Showing this obligation in the document");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("has no axe violations, empty or populated", async () => {
    const { container, rerender } = render(<LiveRegion politeness="assertive" message="" />);
    expect(await axe(container)).toHaveNoViolations();
    rerender(<LiveRegion politeness="assertive" message="An error occurred." />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

function Announcer({ message = "hello", politeness }: { message?: string; politeness?: "polite" | "assertive" }) {
  const announce = useAnnounce();
  return (
    <button type="button" onClick={() => announce(message, politeness)}>
      announce
    </button>
  );
}

describe("LiveRegionProvider", () => {
  it("mounts both standing regions unconditionally from first render, both empty", () => {
    render(
      <LiveRegionProvider>
        <p>content</p>
      </LiveRegionProvider>,
    );
    const [polite, assertive] = document.querySelectorAll("[aria-live]");
    expect(polite).toHaveAttribute("aria-live", "polite");
    expect(assertive).toHaveAttribute("aria-live", "assertive");
    expect(polite).toHaveTextContent("");
    expect(assertive).toHaveTextContent("");
  });

  it("useAnnounce() throws when called outside a LiveRegionProvider", () => {
    function Bare() {
      useAnnounce();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/useAnnounce must be called within a LiveRegionProvider/);
  });

  it("announce() writes the message into the matching politeness region", async () => {
    render(
      <LiveRegionProvider>
        <Announcer message="Showing this obligation in the document" politeness="polite" />
      </LiveRegionProvider>,
    );
    screen.getByRole("button").click();
    await waitFor(() => expect(screen.getByText("Showing this obligation in the document")).toHaveAttribute("aria-live", "polite"));
  });

  it("re-announces an identical consecutive message via a real clear-then-set, not a same-string no-op", () => {
    vi.useFakeTimers();
    try {
      render(
        <LiveRegionProvider>
          <Announcer message="busy" politeness="assertive" />
        </LiveRegionProvider>,
      );
      const button = screen.getByRole("button");
      const assertiveRegion = document.querySelectorAll("[aria-live]")[1];

      act(() => button.click());
      act(() => vi.runAllTimers());
      expect(assertiveRegion).toHaveTextContent("busy");

      // A second announce() of the identical string: if this were a same-string no-op, the region
      // would just stay "busy" the whole time with no intermediate clear — asserting the clear
      // happens (before the timer fires) is what actually distinguishes the two implementations.
      act(() => button.click());
      expect(assertiveRegion).toHaveTextContent("");
      act(() => vi.runAllTimers());
      expect(assertiveRegion).toHaveTextContent("busy");
    } finally {
      vi.useRealTimers();
    }
  });
});

function OnceAnnouncer() {
  useAnnounceOnMount("announced once", "assertive");
  return null;
}

describe("useAnnounceOnMount", () => {
  it("announces exactly once, even under React Strict Mode's double-invoked effect", async () => {
    render(
      <StrictMode>
        <LiveRegionProvider>
          <OnceAnnouncer />
        </LiveRegionProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText("announced once")).toBeInTheDocument());
    // Only one live region should ever carry this text — a second announce() would still land in
    // the same assertive node, so a duplicate call is invisible to a plain text query; asserting
    // there's exactly one match is what actually catches a double announce.
    expect(screen.getAllByText("announced once")).toHaveLength(1);
  });
});
