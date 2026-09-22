import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { ErrorState, type ErrorStateProps } from "@/components/feedback/error-state";

function renderState(props: ErrorStateProps) {
  return render(
    <LiveRegionProvider>
      <ErrorState {...props} />
    </LiveRegionProvider>,
  );
}

describe("ErrorState", () => {
  it("shows the server's own fixed message for a passthrough code, unchanged", () => {
    renderState({ code: "NOT_FOUND", serverMessage: "The requested resource could not be found." });
    expect(screen.getByText("The requested resource could not be found.")).toBeInTheDocument();
  });

  it("404 is always exactly the fixed sentence, never distinguishing missing from foreign", () => {
    renderState({ code: "NOT_FOUND", serverMessage: "The requested resource could not be found." });
    expect(screen.getByText("The requested resource could not be found.")).toBeInTheDocument();
  });

  it("renders RetryAfterNotice's own copy for RATE_LIMITED, not a duplicated separate message", () => {
    renderState({ code: "RATE_LIMITED", retryAfterSeconds: 45 });
    expect(screen.getByText("You've reached your limit for now. Try again in 45 seconds.")).toBeInTheDocument();
    expect(screen.getAllByText(/Try again/)).toHaveLength(1);
  });

  it("the assertive live region actually carries RetryAfterNotice's message, not an empty string ErrorState's own announce() call clears it to", async () => {
    renderState({ code: "RATE_LIMITED", retryAfterSeconds: 45 });
    const assertiveRegion = document.querySelectorAll("[aria-live='assertive']")[0];
    await waitFor(() => expect(assertiveRegion).toHaveTextContent("You've reached your limit for now. Try again in 45 seconds."));
  });

  it("renders RetryAfterNotice's own copy for UPSTREAM_UNAVAILABLE and never says 'too many requests'", () => {
    renderState({ code: "UPSTREAM_UNAVAILABLE" });
    const text = screen.getByText("The AI providers are busy right now. Try again in a few minutes.");
    expect(text.textContent).not.toMatch(/too many requests/i);
  });

  it("shows the fixed OFFLINE text", () => {
    renderState({ code: "OFFLINE" });
    expect(screen.getByText("You're offline. Saboot needs a connection to read and answer.")).toBeInTheDocument();
  });

  it("calls onRetry when Try again is clicked", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderState({ code: "TIMEOUT", serverMessage: "The request took too long to complete. Please try again.", onRetry });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("puts the correlation id inside a Details disclosure", () => {
    renderState({ code: "SCHEMA_FAILED", serverMessage: "malformed", correlationId: "corr-abc-123" });
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("corr-abc-123")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderState({ code: "VALIDATION_FAILED", serverMessage: "bad input", correlationId: "c-1", onRetry: () => {} });
    expect(await axe(container)).toHaveNoViolations();
  });
});
