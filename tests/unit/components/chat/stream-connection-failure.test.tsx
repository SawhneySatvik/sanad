// A genuine mid-read connection failure (src/lib/sse/parse.ts's own `throw new Error("SSE stream
// read failed")`, never a well-formed `event: error` frame) is a different path from the one
// mid-stream-retry.test.tsx already covers — consumeAskStream never catches this one itself, so
// runTurn's own catch must reset streamingText back to null before it returns. Left at "" instead,
// the composer's `streamingText !== null` disable check never lifts again. Mocked at the
// askGuestStream boundary, not a real ReadableStream: jsdom's fetch/ReadableStream integration
// doesn't propagate a throwing pull() the way a real browser's does, so a byte-level repro is not
// reliable in this environment — this drives the exact same thrown-Error shape parse.ts produces.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
import type { SseFrame } from "@/lib/sse";
import { ChatScreen } from "@/components/chat/chat-screen";

vi.mock("@/components/chat/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/chat/api")>();
  return {
    ...actual,
    askGuestStream: vi.fn(async function* (): AsyncGenerator<SseFrame> {
      yield { event: "token", data: { type: "token", text: "Hold on" } };
      throw new Error("SSE stream read failed");
    }),
  };
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("a genuine mid-read connection failure re-enables the composer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("the textarea is no longer disabled once the failure has been handled, with a real Retry under the user's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

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

    const homeTextarea = await screen.findByLabelText("Ask Saboot");
    await userEvent.type(homeTextarea, "what does my lease say about my deposit");
    await userEvent.keyboard("{Enter}");

    // Submitting from chat home swaps the whole tree to the thread layout (a fresh Composer/
    // textarea instance, not the same DOM node) — the failure notice renders in the log, directly
    // under the user message it belongs to, in that new tree.
    const log = screen.getByRole("log");
    await within(log).findByText("what does my lease say about my deposit");
    await within(log).findByRole("button", { name: "Retry" });

    const threadTextarea = screen.getByLabelText("Ask Saboot");
    expect(threadTextarea).not.toBeDisabled();
  });
});
