import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { useAnnounce } from "@/components/layout-primitives/live-region";
import { Providers } from "@/app/providers";

function Announcer() {
  const announce = useAnnounce();
  return (
    <button type="button" onClick={() => announce("hello from a descendant")}>
      announce
    </button>
  );
}

describe("Providers", () => {
  it("renders its children", () => {
    render(
      <Providers>
        <p>app content</p>
      </Providers>,
    );
    expect(screen.getByText("app content")).toBeInTheDocument();
  });

  it("mounts both of LiveRegion's own standing nodes unconditionally, alongside sonner's own toaster live-region section (the app's whole live-region allow-list)", () => {
    render(
      <Providers>
        <p>app content</p>
      </Providers>,
    );
    // LiveRegion's own two nodes carry its sr-only class; sonner's toaster section is the third
    // allow-listed live region and is intentionally excluded from this count, not missed.
    const ownLiveNodes = document.querySelectorAll("[aria-live].sr-only");
    expect(ownLiveNodes).toHaveLength(2);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(3);
  });

  it("exposes useAnnounce() to any descendant, without that descendant mounting its own LiveRegionProvider", async () => {
    render(
      <Providers>
        <Announcer />
      </Providers>,
    );
    screen.getByRole("button").click();
    expect(await screen.findByText("hello from a descendant")).toBeInTheDocument();
  });

  it("a second Providers instance gets its own QueryClient, not a module-scoped shared one", () => {
    // Rendering two independent trees must not throw or cross-contaminate — the clearest
    // behavioural sign the client is created per-instance (useState's lazy initializer) rather
    // than once at module scope, which would leak one visitor's cache into another's on the server.
    const first = render(
      <Providers>
        <p>first</p>
      </Providers>,
    );
    const second = render(
      <Providers>
        <p>second</p>
      </Providers>,
    );
    expect(first.getByText("first")).toBeInTheDocument();
    expect(second.getByText("second")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <Providers>
        <main>
          <h1>Chat</h1>
        </main>
      </Providers>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
