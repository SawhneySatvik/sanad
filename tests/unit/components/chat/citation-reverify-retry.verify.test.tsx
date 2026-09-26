// One-Guarantee gate: POST /api/verify-batch's response is parsed against its own output schema and
// checked for a matching length before any citation resolves from it — a malformed or short response
// must never render a verified badge the server didn't actually produce, and must never crash the
// screen either. A failed chunk's Retry button must actually re-run verify-batch for that chunk, not
// sit there doing nothing. Fakes sit only at the transport boundary (global fetch), never at
// ChatScreen/MessageList/CitationChip/VerificationBadge themselves (CLAUDE.md's mocking policy).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { ChatScreen } from "@/components/chat/chat-screen";

const LOCAL_ID = "local-99999999-9999-4999-8999-999999999999";
const DOCUMENT_ID = "88888888-8888-4888-8888-888888888888";

function seedLocalThread(): void {
  const raw = JSON.stringify({
    id: LOCAL_ID,
    title: "My chat",
    documentIds: [DOCUMENT_ID],
    messages: [
      {
        id: "a1",
        role: "assistant",
        content: "The lease requires 30 days' notice.",
        mode: "grounded",
        citations: [{ quoteText: "thirty days written notice", sourceDocumentId: DOCUMENT_ID, unverifiedCachedStatus: "cached_verified" }],
        createdAtMs: 1,
      },
    ],
  });
  window.localStorage.setItem(`saboot:threads:v1:${LOCAL_ID}`, raw);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function documentResponse(): Response {
  return jsonResponse({
    analysisState: "complete",
    document: {
      id: DOCUMENT_ID,
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

function renderChatScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LiveRegionProvider>
        <NextRouterStub>
          <ChatScreen chatId={LOCAL_ID} />
        </NextRouterStub>
      </LiveRegionProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("verify-batch response shape is checked before a citation resolves from it", () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedLocalThread();
  });

  it("a verified-status response missing its required span fields never renders a verified badge — the citation becomes a retryable failed state instead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith("/api/verify-batch") && init?.method === "POST") {
          // Missing spanStart/spanEnd/spanText/verifierVersion/textHash — a real server response
          // never looks like this, but a cast-only client would still render it as "Verified".
          return jsonResponse({ results: [{ status: "verified" }] });
        }
        if (url.includes(`/api/documents/${DOCUMENT_ID}`)) return documentResponse();
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    renderChatScreen();

    await screen.findByText("Couldn't re-check right now");
    expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(0);
    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry re-checking this citation" })).toBeInTheDocument();
  });

  it("an empty results array (a length mismatch) never crashes the screen — the citation becomes a retryable failed state instead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith("/api/verify-batch") && init?.method === "POST") return jsonResponse({ results: [] });
        if (url.includes(`/api/documents/${DOCUMENT_ID}`)) return documentResponse();
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );

    renderChatScreen();

    await screen.findByText("Couldn't re-check right now");
    expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(0);
  });
});

describe("a failed citation's Retry button re-runs verify-batch for real", () => {
  let verifyBatchCallCount = 0;

  beforeEach(() => {
    window.localStorage.clear();
    seedLocalThread();
    verifyBatchCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith("/api/verify-batch") && init?.method === "POST") {
          verifyBatchCallCount++;
          if (verifyBatchCallCount === 1) return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } }, { status: 500 });
          return jsonResponse({
            results: [
              {
                status: "verified",
                spanStart: 0,
                spanEnd: 27,
                spanText: "thirty days written notice",
                verifierVersion: "v1",
                textHash: "hash-1",
              },
            ],
          });
        }
        if (url.includes(`/api/documents/${DOCUMENT_ID}`)) return documentResponse();
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );
  });

  it("clicking Retry re-runs verify-batch and, once it actually succeeds, renders the server's real verified badge", async () => {
    renderChatScreen();

    const retryButton = await screen.findByRole("button", { name: "Retry re-checking this citation" });
    expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(0);

    await userEvent.click(retryButton);

    await waitFor(() => expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(1));
    const badge = document.querySelector('[data-slot="verification-badge"]');
    expect(badge?.getAttribute("data-verification-status")).toBe("verified");
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(verifyBatchCallCount).toBe(2);
  });
});
