import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/shell/app-shell";
import { refreshLocalThreads } from "@/components/shell/local-threads";
import { NextRouterStub } from "@tests/support/next-router-stub";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubEverythingOk() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/session") return jsonResponse(200, { kind: "guest", signInAvailable: true, guestTtlHours: 3 });
    return jsonResponse(200, { items: [], nextCursor: null });
  });
}

function stubSessionFailure() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/session") {
      return jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
    }
    return jsonResponse(200, { items: [], nextCursor: null });
  });
}

// jsdom's own global matchMedia stub (tests/setup/jsdom.ts) always reports matches: false — every
// query, mobile's included — so useIsMobile()/useSidebar().isMobile stays false unless a test
// overrides it here.
function stubMobileViewport() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

// /settings, not /chat: /chat carries its own composer-adjacent disclaimer, so AppShell suppresses
// its own footer copy there — a generic shell test needs a route that doesn't, matching the same
// anchor-route reasoning 02-shell.spec.ts's own file header states.
function renderShell(children = <h1>Chat</h1>, pathname = "/settings") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <LiveRegionProvider>
        <NextRouterStub pathname={pathname}>
          <TooltipProvider>
            <AppShell>{children}</AppShell>
          </TooltipProvider>
        </NextRouterStub>
      </LiveRegionProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  refreshLocalThreads();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("mounts a SkipLink targeting the main landmark", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell();
    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(document.getElementById("main-content")).toHaveAttribute("tabindex", "-1");
  });

  it("renders exactly one <main> landmark and one <nav aria-label=Primary>", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell();
    await screen.findByRole("link", { name: "Sign in" });
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("navigation", { name: "Primary" })).toHaveLength(1);
  });

  it("renders the footer DisclaimerLine once, inside <main>", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell();
    expect(screen.getByText("Saboot explains documents. It isn't legal advice.")).toBeInTheDocument();
  });

  it("suppresses its own footer disclaimer on /chat and /documents/[id], which carry their own composer-adjacent copy — the <footer> landmark itself still mounts", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell(<h1>Chat</h1>, "/chat");
    await screen.findByRole("link", { name: "Sign in" });
    expect(screen.queryByText("Saboot explains documents. It isn't legal advice.")).not.toBeInTheDocument();
    expect(document.querySelector("footer")).not.toBeNull();
  });

  it("suppresses the footer disclaimer on a /chat/[id] thread route too — its composer carries the same disclaimer as chat home's", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell(<h1>Chat</h1>, "/chat/local-abc");
    await screen.findByRole("link", { name: "Sign in" });
    expect(screen.queryByText("Saboot explains documents. It isn't legal advice.")).not.toBeInTheDocument();
  });

  it("does not mount a second LiveRegionProvider/Toaster/TooltipProvider of its own — the live-region allow-list gate", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell();
    await screen.findByRole("link", { name: "Sign in" });

    // The whole allow-list: LiveRegion's polite + assertive nodes, plus sonner's own toaster
    // section — never a bare count, the actual node set.
    const liveNodes = document.querySelectorAll('[aria-live], [role="alert"], [role="status"], [role="log"]');
    const roles = Array.from(liveNodes).map((node) => ({
      // sonner's own toaster section carries this exact aria-label — the section itself is what
      // matches [aria-live], not its child <ol data-sonner-toaster>.
      isToaster: node.getAttribute("aria-label") === "Notifications alt+T",
      srOnly: node.classList.contains("sr-only"),
    }));
    expect(roles).toHaveLength(3);
    expect(roles.filter((r) => r.srOnly)).toHaveLength(2);
    expect(roles.filter((r) => r.isToaster)).toHaveLength(1);
  });

  it("gives <main> a definite height and puts the scroll boundary on the content wrapper, not <main> itself", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell();
    await screen.findByRole("link", { name: "Sign in" });

    // A route's own root can rely on `h-full` resolving to real pixels (the workspace split,
    // later chat) only if <main> itself has a definite height, not just a min-height, and never
    // scrolls on its own — the content wrapper below is the one boundary that does.
    const main = screen.getByRole("main");
    expect(main.className).toMatch(/\bh-svh\b/);
    expect(main.className).toMatch(/\boverflow-hidden\b/);

    const content = main.querySelector('[data-slot="app-shell-content"]');
    expect(content).not.toBeNull();
    expect(content?.className).toMatch(/\bmin-h-0\b/);
    expect(content?.className).toMatch(/\boverflow-y-auto\b/);
  });

  it("shows a session-failure notice with Try again under the phone top bar when the session fetch fails and the viewport is mobile", async () => {
    stubMobileViewport();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubSessionFailure());
    renderShell();
    expect(await screen.findByText("We couldn't check your session, so some features are hidden.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("never duplicates the session-failure notice on desktop — only the sidebar's own copy renders", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubSessionFailure());
    renderShell();
    expect(await screen.findAllByText("We couldn't check your session, so some features are hidden.")).toHaveLength(1);
  });

  it("gives the mobile 'Open menu' button a 44px hit area (size-11) with a size-5 glyph", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    renderShell();
    const button = screen.getByRole("button", { name: "Open menu" });
    expect(button.className).toMatch(/\bsize-11\b/);
    expect(button.querySelector("svg")?.getAttribute("class")).toMatch(/\bsize-5\b/);
  });

  it("has no axe violations at rest", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEverythingOk());
    const { container } = renderShell();
    await screen.findByRole("link", { name: "Sign in" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
