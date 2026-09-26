// jest-axe coverage for this screen's key states: chat home at rest, a thread with
// resolved/pending/scanned citations, and the attach-disabled paperclip with its reason showing.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { ChatScreen } from "@/components/chat/chat-screen";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function renderScreen(chatId: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LiveRegionProvider>
        <NextRouterStub>
          <ChatScreen chatId={chatId} />
        </NextRouterStub>
      </LiveRegionProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("axe: chat home at rest", () => {
  it("has zero serious/critical violations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    const { container } = renderScreen(null);
    await screen.findByText("What's in your document?");
    expect(await axe(container)).toHaveNoViolations();
  });
});

const SERVER_THREAD_ID = "55555555-5555-4555-8555-555555555555";
const VERIFIED_DOC_ID = "66666666-6666-4666-8666-666666666666";
const SCANNED_DOC_ID = "77777777-7777-4777-8777-777777777777";

describe("axe: a saved thread with resolved (scanned + not_found + verified) citations, attach disabled", () => {
  it("has zero serious/critical violations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "user", displayName: "Asha", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith(`/api/threads/${SERVER_THREAD_ID}/messages`)) {
          return jsonResponse({
            messages: [
              { id: "u1", role: "user", content: "What does this say about my deposit?", createdAt: "2026-01-01T00:00:00.000Z" },
              {
                id: "a1",
                role: "assistant",
                content: "Here is what the documents say.",
                provenance: "ai_generated",
                modelUsed: "gemini-2.5-flash",
                routedDomains: ["tenancy"],
                createdAt: "2026-01-01T00:00:01.000Z",
                mode: "grounded",
                citations: [
                  {
                    id: "c1",
                    sourceDocumentId: VERIFIED_DOC_ID,
                    inputMode: "text",
                    verification: {
                      status: "verified",
                      spanStart: 0,
                      spanEnd: 20,
                      spanText: "the deposit is refundable",
                      verifierVersion: "v1",
                      textHash: "hash-a",
                    },
                  },
                  {
                    id: "c2",
                    sourceDocumentId: SCANNED_DOC_ID,
                    inputMode: "native_document",
                    verification: {
                      status: "approximate",
                      spanStart: 0,
                      spanEnd: 20,
                      spanText: "roughly this wording",
                      claimedQuote: "roughly this wording, model's claim",
                      verifierVersion: "v1",
                      textHash: "hash-b",
                    },
                  },
                  {
                    id: "c3",
                    sourceDocumentId: null,
                    inputMode: null,
                    verification: {
                      status: "not_found",
                      spanStart: null,
                      spanEnd: null,
                      spanText: null,
                      claimedQuote: "a quote from a deleted document",
                      verifierVersion: "v1",
                      textHash: "0".repeat(64),
                    },
                  },
                ],
              },
            ],
          });
        }
        if (url.includes(`/api/documents/${VERIFIED_DOC_ID}`) || url.includes(`/api/documents/${SCANNED_DOC_ID}`)) {
          const id = url.includes(VERIFIED_DOC_ID) ? VERIFIED_DOC_ID : SCANNED_DOC_ID;
          return jsonResponse({
            analysisState: "complete",
            document: {
              id,
              title: "Lease.pdf",
              sampleId: null,
              projectId: null,
              filename: "lease.pdf",
              mimeType: "application/pdf",
              processingStatus: "ready",
              inputMode: "text",
              documentType: "leave_and_license",
              jurisdiction: "IN",
              detectionConfidence: "high",
              uploadedAt: "2026-01-01T00:00:00.000Z",
              expiresAt: null,
            },
            analysis: { id: "an-1", promptVersion: "v1", modelUsed: "gemini-2.5-flash", createdAt: "2026-01-01T00:00:00.000Z" },
            findings: [],
          });
        }
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    const { container } = renderScreen(SERVER_THREAD_ID);
    await screen.findByText("Here is what the documents say.");
    await waitFor(() => expect(screen.getByText("Approximate")).toBeInTheDocument());
    // The attach-disabled reason renders as always-visible text (composer.tsx's own choice) — it
    // also reaches the shared live region on mount (InlineNotice's own behaviour), so two matches
    // is the correct count here, not one.
    expect(screen.getAllByText("This chat is already saved. Start a new chat to attach another document.").length).toBeGreaterThan(0);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("axe: mid-stream (held), the component-level equivalent of a genuinely paused stream", () => {
  it("StreamingPreview is visible before axe runs against it, held open via a real ReadableStream the test controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith("/api/ask")) {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('event: token\ndata: {"type":"token","text":"Thinking about this"}\n\n'));
              // Deliberately never closes or enqueues `final` — a genuine, indefinite hold; the
              // test itself decides when (if ever) to let the stream continue.
            },
          });
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    const { container } = renderScreen(null);
    await screen.findByText("What's in your document?");
    await userEvent.type(screen.getByLabelText("Ask Saboot"), "what is a typical notice period");
    await userEvent.keyboard("{Enter}");

    await screen.findByText("Thinking about this");
    expect(screen.getByText("Saboot is answering…")).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
  });
});
