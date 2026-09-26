// A mid-stream error discards the preview and keeps the user's message; a manual Retry resubmits
// the exact same query verbatim, through the same path, without leaving two identical user bubbles
// behind (the failed attempt's own bubble is folded away in favour of the retried one).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { GENERAL_MODE_LABEL } from "@/shared/contracts/threads";
import { ChatScreen } from "@/components/chat/chat-screen";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const FAILING_FRAMES = [
  'event: token\ndata: {"type":"token","text":"Hold on"}\n\n',
  'event: error\ndata: {"error":{"code":"UPSTREAM_UNAVAILABLE","message":"The AI providers are busy right now. Try again in a few minutes."}}\n\n',
];

function successFrames(): string[] {
  const message = {
    id: null,
    role: "assistant",
    content: "General information about notice periods.",
    provenance: "ai_generated",
    modelUsed: "gemini-2.5-flash",
    routedDomains: ["general_legal"],
    createdAt: null,
    mode: "general",
    redirect: false,
    label: GENERAL_MODE_LABEL,
  };
  return ['event: token\ndata: {"type":"token","text":"General "}\n\n', `event: final\ndata: ${JSON.stringify({ type: "final", message })}\n\n`];
}

describe("mid-stream error -> manual Retry", () => {
  let askCallCount = 0;
  let lastAskBody: unknown;

  beforeEach(() => {
    window.localStorage.clear();
    askCallCount = 0;
    lastAskBody = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith("/api/ask") && init?.method === "POST") {
          askCallCount++;
          lastAskBody = JSON.parse(init.body as string);
          return askCallCount === 1 ? sseResponse(FAILING_FRAMES) : sseResponse(successFrames());
        }
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("keeps the user's message, discards the preview, and Retry resends the identical query with exactly one user bubble afterward", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LiveRegionProvider>
          <NextRouterStub>
            <ChatScreen chatId={null} />
          </NextRouterStub>
        </LiveRegionProvider>
      </QueryClientProvider>,
    );

    const textarea = await screen.findByLabelText("Ask Saboot");
    await userEvent.type(textarea, "What counts as a valid notice to vacate?");
    await userEvent.keyboard("{Enter}");

    // The user's own message survives the failure; the streamed preview text is discarded. Scoped
    // to the log region, since the visually-hidden <h1> also carries the query as the thread's
    // derived title — a real, separate element, not a duplicate message bubble.
    const log = screen.getByRole("log");
    await within(log).findByText("What counts as a valid notice to vacate?");
    // Matches both the visible <p> and the assertive live region's own announcement — both are
    // legitimate, so this asserts presence via getAllByText rather than a single-match query.
    await waitFor(() => expect(screen.getAllByText(/AI providers are busy/).length).toBeGreaterThan(0));
    expect(screen.queryByText("Hold on")).toBeNull();
    expect(within(log).getAllByText("What counts as a valid notice to vacate?")).toHaveLength(1);

    const retryButton = screen.getByRole("button", { name: "Retry" });
    await userEvent.click(retryButton);

    await waitFor(() => expect(askCallCount).toBe(2));
    expect((lastAskBody as { query: string }).query).toBe("What counts as a valid notice to vacate?");

    await within(log).findByText("General information about notice periods.");
    // Still exactly one user bubble for this turn — the failed attempt's own bubble was folded away.
    expect(within(log).getAllByText("What counts as a valid notice to vacate?")).toHaveLength(1);
    // The error state and its Retry button are both gone — the turn succeeded.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
