// A reopened local thread's own documentIds are fetched to resolve their chip labels; an expired or
// otherwise-gone guest document must never leave that fetch's rejection unhandled — it falls back to
// a neutral, still-removable chip instead of crashing the run.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { ChatScreen } from "@/components/chat/chat-screen";

const LOCAL_ID = "local-77777777-7777-4777-8777-777777777777";
const EXPIRED_DOC_ID = "66666666-6666-4666-8666-666666666666";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function seedLocalThread(): void {
  const raw = JSON.stringify({
    id: LOCAL_ID,
    title: "My chat",
    documentIds: [EXPIRED_DOC_ID],
    messages: [{ id: "u1", role: "user", content: "hello", mode: null, citations: [], createdAtMs: 1 }],
  });
  window.localStorage.setItem(`saboot:threads:v1:${LOCAL_ID}`, raw);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("a reopened local thread's expired attachment", () => {
  it("falls back to a neutral, removable chip instead of an unhandled rejection", async () => {
    seedLocalThread();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.includes(`/api/documents/${EXPIRED_DOC_ID}`)) {
          return jsonResponse({ error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 });
        }
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LiveRegionProvider>
          <NextRouterStub>
            <ChatScreen chatId={LOCAL_ID} />
          </NextRouterStub>
        </LiveRegionProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Attached document")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Attached document" })).toBeInTheDocument();
  });
});
