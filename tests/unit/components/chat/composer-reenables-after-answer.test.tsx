// A successful grounded turn re-enables the composer once its citations render — the home->thread
// mode swap remounts Composer/Textarea as a fresh DOM node, so this re-queries by label after the
// answer lands rather than reusing the home-mode textarea reference captured before submitting.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
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

const ATTACHED_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

function finalFrame() {
  const message = {
    id: null,
    role: "assistant",
    content: "Here is what the lease says about your deposit.",
    provenance: "ai_generated",
    modelUsed: "gemini-2.5-flash",
    routedDomains: ["tenancy"],
    createdAt: null,
    mode: "grounded",
    citations: [
      {
        id: null,
        sourceDocumentId: ATTACHED_DOCUMENT_ID,
        inputMode: "text",
        verification: { status: "verified", spanStart: 0, spanEnd: 30, spanText: "the deposit is fully refundable", verifierVersion: "v1", textHash: "hash-a" },
      },
    ],
  };
  return `event: final\ndata: ${JSON.stringify({ type: "final", message })}\n\n`;
}

describe("composer re-enables after a successful grounded turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("the textarea is not disabled once the citations render, re-queried post mode-swap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith("/api/ask") && init?.method === "POST") return sseResponse([finalFrame()]);
        // Not mocked to succeed: the reopen re-verify pass's own request outcome (found or not)
        // must never be able to flip the composer back to disabled either way.
        if (url.endsWith("/api/verify-batch") && init?.method === "POST") {
          return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }), { status: 404 });
        }
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

    const log = screen.getByRole("log");
    await within(log).findByText("Here is what the lease says about your deposit.");

    const threadTextarea = screen.getByLabelText("Ask Saboot");
    expect(threadTextarea).not.toBeDisabled();
  });
});
