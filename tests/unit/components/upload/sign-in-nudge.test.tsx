import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { SignInNudge } from "@/components/upload/sign-in-nudge";

function renderNudge(props: React.ComponentProps<typeof SignInNudge>) {
  return render(
    <LiveRegionProvider>
      <SignInNudge {...props} />
    </LiveRegionProvider>,
  );
}

describe("SignInNudge", () => {
  it("renders the exact 'Sign in to keep this' copy for the second_upload context", () => {
    renderNudge({ context: "second_upload", onSignIn: vi.fn() });
    expect(screen.getByText("Sign in to keep this")).toBeInTheDocument();
  });

  it("calls onSignIn when the Sign in button is activated", async () => {
    const onSignIn = vi.fn();
    const user = userEvent.setup();
    renderNudge({ context: "second_upload", onSignIn });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("is per-session dismissible — dismissing removes its own note region from the DOM", async () => {
    const user = userEvent.setup();
    const { container } = renderNudge({ context: "second_upload", onSignIn: vi.fn() });
    expect(container.querySelector('[role="note"]')).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    // The assertive LiveRegion still carries the last-announced text (by design — it's a separate,
    // always-mounted node) — the real assertion is that this component's own note region is gone.
    expect(container.querySelector('[role="note"]')).not.toBeInTheDocument();
  });

  it("is not role=alert, not a dialog, and doesn't trap focus", () => {
    const { container } = renderNudge({ context: "second_upload", onSignIn: vi.fn() });
    expect(container.querySelector('[role="alert"]')).not.toBeInTheDocument();
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument();
    expect(container.querySelector('[role="note"]')).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderNudge({ context: "second_upload", onSignIn: vi.fn() });
    expect(await axe(container)).toHaveNoViolations();
  });
});
