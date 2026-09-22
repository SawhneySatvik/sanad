import { renderToString } from "react-dom/server";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { OfflineBanner } from "@/components/feedback/offline-banner";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderBanner() {
  return render(
    <LiveRegionProvider>
      <OfflineBanner />
    </LiveRegionProvider>,
  );
}

describe("OfflineBanner", () => {
  it("renders nothing while online", () => {
    vi.stubGlobal("navigator", { onLine: true });
    renderBanner();
    expect(screen.queryByText("You're offline. Saboot needs a connection to read and answer.")).not.toBeInTheDocument();
  });

  it("renders the fixed text when navigator.onLine is false", () => {
    vi.stubGlobal("navigator", { onLine: false });
    renderBanner();
    expect(screen.getByText("You're offline. Saboot needs a connection to read and answer.")).toBeInTheDocument();
  });

  it("appears when the window fires its own offline event mid-session", () => {
    const nav = { onLine: true };
    vi.stubGlobal("navigator", nav);
    renderBanner();
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();

    act(() => {
      nav.onLine = false;
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
  });

  it("is not itself one of the app's live regions — role=note, not role=alert or role=status", () => {
    vi.stubGlobal("navigator", { onLine: false });
    renderBanner();
    const banner = screen.getByText("You're offline. Saboot needs a connection to read and answer.").closest("[role]");
    expect(banner).toHaveAttribute("role", "note");
  });

  it("has no axe violations while visible", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { container } = renderBanner();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("never renders as offline during server rendering, even with navigator.onLine already false — useSyncExternalStore's server snapshot always says online, so hydration can't mismatch", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const html = renderToString(
      <LiveRegionProvider>
        <OfflineBanner />
      </LiveRegionProvider>,
    );
    expect(html).not.toContain("You're offline");
  });
});
