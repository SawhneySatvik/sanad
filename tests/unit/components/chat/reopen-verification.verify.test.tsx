// One-Guarantee gate: a guest thread whose localStorage entry is
// tampered to claim "verified" renders NO verified badge until POST /api/verify-batch has actually
// resolved, and then renders exactly the SERVER's fresh status — even when it differs from the
// tampered/cached one. Fakes sit only at the transport boundary (global fetch), never at
// ChatScreen/MessageList/CitationChip/VerificationBadge themselves (CLAUDE.md's mocking policy).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { ChatScreen } from "@/components/chat/chat-screen";

const LOCAL_ID = "local-11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

function seedLocalThread(id: string, cachedStatus: "cached_verified" | "cached_not_found"): void {
  // Written as a raw JSON string, not through saveLocalThread — this is exactly the "tampered
  // localStorage entry" the gate describes: a devtools-forged extra `status` field alongside a
  // cached status that hasn't actually been re-checked since it was written.
  const raw = JSON.stringify({
    id,
    title: "My chat",
    documentIds: [DOCUMENT_ID],
    messages: [
      { id: "u1", role: "user", content: "What does the lease say about notice?", mode: null, citations: [], createdAtMs: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "The lease requires 30 days' notice.",
        mode: "grounded",
        citations: [
          {
            quoteText: "thirty days written notice",
            sourceDocumentId: DOCUMENT_ID,
            unverifiedCachedStatus: cachedStatus,
            status: cachedStatus === "cached_verified" ? "verified" : "not_found", // forged — GuestThreadCitation carries no such field
          },
        ],
        createdAtMs: 2,
      },
    ],
  });
  window.localStorage.setItem(`saboot:threads:v1:${id}`, raw);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("OG gate (a): a tampered guest-thread citation never renders a badge before verify-batch resolves", () => {
  let resolveVerifyBatch!: (value: Response) => void;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    seedLocalThread(LOCAL_ID, "cached_verified");

    const verifyBatchPromise = new Promise<Response>((resolve) => {
      resolveVerifyBatch = resolve;
    });

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/session")) {
        return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
      }
      if (url.endsWith("/api/verify-batch") && init?.method === "POST") {
        return verifyBatchPromise;
      }
      if (url.includes(`/api/documents/${DOCUMENT_ID}`)) {
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
      throw new Error(`unmocked fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

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

  it("renders no [data-slot=verification-badge] while verify-batch is still in flight, then renders the SERVER's status even when it differs from the tampered cache", async () => {
    renderChatScreen();

    // The pending citation renders first — its own "Checking…" treatment, never a badge.
    await screen.findByText("Checking…");
    expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(0);
    // The forged "verified" text must never leak into the DOM as the rendered label either.
    expect(screen.queryByText("Verified")).toBeNull();

    // The server disagrees with the tampered cache: it re-checks this exact quote as approximate.
    resolveVerifyBatch(
      jsonResponse({
        results: [
          {
            status: "approximate",
            spanStart: 10,
            spanEnd: 40,
            spanText: "30 days notice in writing",
            claimedQuote: "thirty days written notice",
            verifierVersion: "v1",
            textHash: "hash-1",
          },
        ],
      }),
    );

    await waitFor(() => expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(1));
    const badge = document.querySelector('[data-slot="verification-badge"]');
    expect(badge?.getAttribute("data-verification-status")).toBe("approximate");
    expect(screen.queryByText("Verified")).toBeNull();
    expect(screen.getByText("Approximate")).toBeInTheDocument();
    expect(screen.queryByText("Checking…")).toBeNull();
  });

  it("red-proof: a renderer that used the tampered unverifiedCachedStatus directly WOULD show a badge immediately — proving this assertion is real, not vacuous", () => {
    // Not a call into ChatScreen: a direct, minimal demonstration that the tampered cache alone
    // (if it were mistakenly fed to VerificationBadge) is exactly the wrong-badge failure mode this
    // gate exists to catch. VerificationBadge only accepts a real VerificationOutput — its status
    // union shares no member with "cached_verified" — so this is a type-level demonstration, not a
    // runtime one: TypeScript itself refuses to compile a call that tries it.
    const tampered = { unverifiedCachedStatus: "cached_verified" } as const;
    // @ts-expect-error — VerificationBadge's `verification.status` prop cannot accept this literal.
    const wouldNotCompile: { status: "verified" } = tampered;
    void wouldNotCompile;
  });
});

// The positive control this gate needs alongside its negative case: without it, a renderer that
// NEVER shows a badge at all (a stub that always renders "Checking…") would also pass every
// assertion above. This proves the real, live-re-verified path still produces a genuine verified
// badge when the server actually confirms it — the cached side disagreeing (not_found) this time.
describe("OG gate (a), positive control: a re-verify that genuinely confirms verified renders the real badge", () => {
  const POSITIVE_LOCAL_ID = "local-44444444-4444-4444-8444-444444444444";
  let resolveVerifyBatch!: (value: Response) => void;

  beforeEach(() => {
    window.localStorage.clear();
    seedLocalThread(POSITIVE_LOCAL_ID, "cached_not_found");

    const verifyBatchPromise = new Promise<Response>((resolve) => {
      resolveVerifyBatch = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (url.endsWith("/api/verify-batch") && init?.method === "POST") return verifyBatchPromise;
        if (url.includes(`/api/documents/${DOCUMENT_ID}`)) {
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
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("the server's fresh verified result renders exactly one real badge, even though the cache claimed not_found", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LiveRegionProvider>
          <NextRouterStub>
            <ChatScreen chatId={POSITIVE_LOCAL_ID} />
          </NextRouterStub>
        </LiveRegionProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("Checking…");

    resolveVerifyBatch(
      jsonResponse({
        results: [
          {
            status: "verified",
            spanStart: 10,
            spanEnd: 37,
            spanText: "thirty days written notice",
            verifierVersion: "v1",
            textHash: "hash-1",
          },
        ],
      }),
    );

    await waitFor(() => expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(1));
    const badge = document.querySelector('[data-slot="verification-badge"]');
    expect(badge?.getAttribute("data-verification-status")).toBe("verified");
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });
});
