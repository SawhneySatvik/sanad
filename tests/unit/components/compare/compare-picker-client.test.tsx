// Zero documents replaces the whole picker with one empty state — the slot cards and Compare
// button are meaningless with nothing to fill them, and showing them disabled under an empty-state
// message reads as two competing explanations for the same thing.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { ComparePickerClient } from "@/components/compare/picker/compare-picker-client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function renderPicker() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextRouterStub>
        {/* useSearchParams() throws with no ancestor at all — NextRouterStub covers useRouter/
            usePathname only, this component's own picker also reads ?a= for its deep-link seed. */}
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <ComparePickerClient />
        </SearchParamsContext.Provider>
      </NextRouterStub>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ComparePickerClient — zero documents", () => {
  it("shows one empty state with a link to /chat, and no slot cards or Compare button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/documents")) return jsonResponse({ items: [], nextCursor: null });
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    renderPicker();

    expect(await screen.findByText("No documents yet.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Go to chat to add a document" });
    expect(link).toHaveAttribute("href", "/chat");
    expect(screen.queryByText("Document A")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
  });
});

describe("ComparePickerClient — documents available", () => {
  it("shows the real picker, never the empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/documents")) {
          return jsonResponse({ items: [{ id: "doc-1", title: "Lease.pdf", processingStatus: "ready" }], nextCursor: null });
        }
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    renderPicker();

    expect(await screen.findByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(screen.getByText("Document A")).toBeInTheDocument();
    expect(screen.queryByText("No documents yet.")).not.toBeInTheDocument();
  });
});
