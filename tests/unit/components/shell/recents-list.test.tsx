import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { SidebarProvider } from "@/components/ui/sidebar";
import { RecentsList } from "@/components/shell/recents-list";
import { refreshLocalThreads } from "@/components/shell/local-threads";
import { saveThread, createEmptyThread } from "@/lib/guest-thread-store";
import { NextRouterStub, fakeAppRouter } from "@tests/support/next-router-stub";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function emptyList() {
  return { items: [], nextCursor: null };
}

/**
 * A fresh Response instance per call, never one shared instance across the four concurrent list
 * GETs — a Response body can only be read once, and reusing one via mockResolvedValue leaves every
 * caller but the first stuck awaiting an already-consumed stream forever (confirmed empirically: 3
 * of 4 queries stayed status "pending" indefinitely with mockResolvedValue).
 */
function stubEmptyListsFetch(): ReturnType<typeof vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>> {
  return vi.fn(async () => jsonResponse(200, emptyList()));
}

function renderRecents(options: { pathname?: string; router?: ReturnType<typeof fakeAppRouter> } = {}) {
  const queryClient = new QueryClient();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextRouterStub pathname={options.pathname ?? "/chat"} router={options.router}>
        <SidebarProvider>
          <RecentsList />
        </SidebarProvider>
      </NextRouterStub>
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

beforeEach(() => {
  window.localStorage.clear();
  refreshLocalThreads();
});
afterEach(() => {
  vi.unstubAllGlobals();
  toast.dismiss();
});

describe("RecentsList", () => {
  it("shows 'Nothing here yet' with no server rows and no local threads", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEmptyListsFetch());
    renderRecents();
    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
  });

  it("a guest with 3 local threads, one document and one comparison sees exactly 5 rows", async () => {
    saveThread(window.localStorage, "saboot:threads:v1:local-a", createEmptyThread("local-a", "Thread A"));
    saveThread(window.localStorage, "saboot:threads:v1:local-b", createEmptyThread("local-b", "Thread B"));
    saveThread(window.localStorage, "saboot:threads:v1:local-c", createEmptyThread("local-c", "Thread C"));
    window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-a", "local-b", "local-c"]));

    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/documents")) {
          return jsonResponse(200, {
            items: [
              {
                id: "doc-1", title: "Lease.pdf", filename: "lease.pdf", documentType: "leave_and_license",
                processingStatus: "ready", analysisState: "complete", inputMode: "text", sampleId: null,
                projectId: null, uploadedAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", expiresAt: null,
              },
            ],
            nextCursor: null,
          });
        }
        if (url.startsWith("/api/comparisons")) {
          return jsonResponse(200, {
            items: [
              {
                id: "cmp-1", title: "Compare", titleA: "A", titleB: "B", documentAId: "doc-a", documentBId: "doc-b",
                modelUsed: "gemini", projectId: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", expiresAt: null,
              },
            ],
            nextCursor: null,
          });
        }
        // /api/threads (a guest gets an empty list) and /api/drafts
        return jsonResponse(200, emptyList());
      }),
    );

    renderRecents();

    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: /Thread A|Thread B|Thread C|Lease\.pdf|Compare/ })).toHaveLength(5);
    });
  });

  it("stacks a row with an expiry line under its title rather than truncating the title against it (D4)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/documents")) {
          return jsonResponse(200, {
            items: [
              {
                id: "doc-1", title: "A genuinely long document title that would otherwise fight the expiry label for space.pdf",
                filename: "lease.pdf", documentType: "leave_and_license", processingStatus: "ready",
                analysisState: "complete", inputMode: "text", sampleId: null, projectId: null,
                uploadedAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          });
        }
        return jsonResponse(200, emptyList());
      }),
    );

    renderRecents();
    const title = await screen.findByText(/A genuinely long document title/);
    const row = title.closest('[data-slot="sidebar-menu-button"]');
    expect(row).not.toBeNull();
    expect(row?.className).toMatch(/\bflex-col\b/);
    expect(row?.className).toMatch(/\bitems-start\b/);
    expect(title.className).toMatch(/\btruncate\b/);
    expect(screen.getByText(/Deletes in about/).tagName).toBe("SPAN");
  });

  it("renames a row without the row's parent list re-mounting", async () => {
    const user = userEvent.setup();
    saveThread(window.localStorage, "saboot:threads:v1:local-a", createEmptyThread("local-a", "Old title"));
    window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-a"]));
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEmptyListsFetch());

    renderRecents();
    await screen.findByText("Old title");
    // The sidebar's own <ul data-slot="sidebar-menu"> — sonner's toaster <ol> is also role="list",
    // so a bare getByRole("list") is ambiguous the moment a toast has fired; this selector is the
    // one stable marker that must survive the rename unchanged (never remounted).
    const marker = document.querySelector('[data-slot="sidebar-menu"]');
    expect(marker).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Actions for Old title" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByLabelText("Name");
    await user.clear(field);
    await user.type(field, "New title");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("New title")).toBeInTheDocument();
    expect(screen.queryByText("Old title")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="sidebar-menu"]')).toBe(marker);
  });

  it("deletes a local thread row directly, without calling the API", async () => {
    const user = userEvent.setup();
    saveThread(window.localStorage, "saboot:threads:v1:local-a", createEmptyThread("local-a", "Doomed thread"));
    window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify(["local-a"]));
    vi.stubGlobal("navigator", { onLine: true });
    const fetchSpy = stubEmptyListsFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderRecents();
    await screen.findByText("Doomed thread");

    await user.click(screen.getByRole("button", { name: "Actions for Doomed thread" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Doomed thread")).not.toBeInTheDocument());
    // Every call made was a GET list read — never a DELETE for a purely local thread.
    for (const call of fetchSpy.mock.calls) {
      expect(call[1]?.method ?? "GET").not.toBe("DELETE");
    }
  });

  it("has no axe violations at rest", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", stubEmptyListsFetch());
    const { container } = renderRecents();
    await screen.findByText("Nothing here yet");
    expect(await axe(container)).toHaveNoViolations();
  });
});
