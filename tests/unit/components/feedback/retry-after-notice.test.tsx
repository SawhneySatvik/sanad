import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { RetryAfterNotice } from "@/components/feedback/retry-after-notice";

function renderNotice(props: React.ComponentProps<typeof RetryAfterNotice>) {
  return render(
    <LiveRegionProvider>
      <RetryAfterNotice {...props} />
    </LiveRegionProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RetryAfterNotice", () => {
  it("formats the {time} sentence for RATE_LIMITED with a retry time", () => {
    renderNotice({ kind: "RATE_LIMITED", retryAfterSeconds: 45 });
    expect(screen.getByText("You've reached your limit for now. Try again in 45 seconds.")).toBeInTheDocument();
  });

  it("falls back to the vague RATE_LIMITED copy without a retry time", () => {
    renderNotice({ kind: "RATE_LIMITED" });
    expect(screen.getByText("You've reached your limit for now. Try again in a little while.")).toBeInTheDocument();
  });

  it("formats the {time} sentence for UPSTREAM_UNAVAILABLE and never says 'too many requests'", () => {
    renderNotice({ kind: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 180 });
    const text = screen.getByText("The AI providers are busy right now. Try again in 3 minutes.");
    expect(text).toBeInTheDocument();
    expect(text.textContent).not.toMatch(/too many requests/i);
  });

  it("falls back to the vague UPSTREAM_UNAVAILABLE copy without a retry time", () => {
    renderNotice({ kind: "UPSTREAM_UNAVAILABLE" });
    expect(screen.getByText("The AI providers are busy right now. Try again in a few minutes.")).toBeInTheDocument();
  });

  it("visually counts down each second without re-announcing", () => {
    vi.useFakeTimers();
    renderNotice({ kind: "RATE_LIMITED", retryAfterSeconds: 3 });
    expect(screen.getByText("You've reached your limit for now. Try again in 3 seconds.")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("You've reached your limit for now. Try again in 2 seconds.")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("You've reached your limit for now. Try again in 1 second.")).toBeInTheDocument();
  });

  it("reaches zero and falls back to the vague suffix rather than showing '0 seconds'", () => {
    vi.useFakeTimers();
    renderNotice({ kind: "RATE_LIMITED", retryAfterSeconds: 1 });
    expect(screen.getByText("You've reached your limit for now. Try again in 1 second.")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("You've reached your limit for now. Try again in a little while.")).toBeInTheDocument();
  });

  it("resets its own countdown when retryAfterSeconds changes on a re-render (a fresh error, not a stale one)", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <LiveRegionProvider>
        <RetryAfterNotice kind="RATE_LIMITED" retryAfterSeconds={5} />
      </LiveRegionProvider>,
    );
    act(() => vi.advanceTimersByTime(3000)); // down to 2 seconds remaining
    expect(screen.getByText("You've reached your limit for now. Try again in 2 seconds.")).toBeInTheDocument();

    rerender(
      <LiveRegionProvider>
        <RetryAfterNotice kind="RATE_LIMITED" retryAfterSeconds={20} />
      </LiveRegionProvider>,
    );
    expect(screen.getByText("You've reached your limit for now. Try again in 20 seconds.")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderNotice({ kind: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 30 });
    expect(await axe(container)).toHaveNoViolations();
  });
});
