import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { refreshLocalThreads } from "@/components/shell/local-threads";
import { NextRouterStub } from "@tests/support/next-router-stub";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubListsAndSession(session: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/session") return jsonResponse(200, session);
    return jsonResponse(200, { items: [], nextCursor: null });
  });
}

function renderSidebar(pathname = "/chat") {
  // retry: false — the session-failure tests need the query to settle into its error state inside
  // findByText's default wait window, not spend several real seconds on the default retry backoff.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LiveRegionProvider>
        <NextRouterStub pathname={pathname}>
          <TooltipProvider>
            <SidebarProvider>
              <AppSidebar />
            </SidebarProvider>
          </TooltipProvider>
        </NextRouterStub>
      </LiveRegionProvider>
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

describe("AppSidebar", () => {
  it("marks the current route's nav item aria-current=page", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubListsAndSession({ kind: "guest", signInAvailable: true, guestTtlHours: 3 }));
    renderSidebar("/chat");

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
    });
    expect(screen.getByRole("link", { name: "Library" })).not.toHaveAttribute("aria-current");
  });

  it("Projects is a plain link with no flyout or expando", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubListsAndSession({ kind: "guest", signInAvailable: true, guestTtlHours: 3 }));
    renderSidebar();

    const projects = await screen.findByRole("link", { name: "Projects" });
    expect(projects).toHaveAttribute("href", "/projects");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows 'Sign in' when signInAvailable is true and the session is a guest", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubListsAndSession({ kind: "guest", signInAvailable: true, guestTtlHours: 3 }));
    renderSidebar();
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows no sign-in affordance at all when signInAvailable is false (absent, not disabled)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubListsAndSession({ kind: "guest", signInAvailable: false, guestTtlHours: 3 }));
    renderSidebar();
    await screen.findByRole("link", { name: "Chat" });
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
  });

  it("shows the display name and a sign-out control for a signed-in user", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      stubListsAndSession({ kind: "user", displayName: "Ada", signInAvailable: true, guestTtlHours: 3 }),
    );
    renderSidebar();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Sign out")).toBeInTheDocument();
  });

  it("session failure hides every signed-in/nudge affordance and shows the InlineNotice with Try again", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/session") {
          return jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
        }
        return jsonResponse(200, { items: [], nextCursor: null });
      }),
    );
    renderSidebar();

    expect(
      await screen.findByText("We couldn't check your session, so some features are hidden."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
  });

  it("clicking Try again refetches the session and the notice unmounts on success", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { onLine: true });
    let sessionCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/session") {
          sessionCallCount += 1;
          if (sessionCallCount === 1) {
            return jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
          }
          return jsonResponse(200, { kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        }
        return jsonResponse(200, { items: [], nextCursor: null });
      }),
    );
    renderSidebar();

    await screen.findByText("We couldn't check your session, so some features are hidden.");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    // Not a text search: the live region keeps the last-announced message around by design (an
    // announcement is never retracted) — the notice's own role="note" element is the real signal.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument());
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("has no axe violations, expanded", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubListsAndSession({ kind: "guest", signInAvailable: true, guestTtlHours: 3 }));
    const { container } = renderSidebar();
    await screen.findByRole("link", { name: "Sign in" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
