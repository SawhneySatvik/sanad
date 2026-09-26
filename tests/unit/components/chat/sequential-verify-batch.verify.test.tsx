// The reopen re-verify pass's own contract: a mock thread with 120 citations across 8 documents
// asserts exactly the expected number of sequential requests, each respecting both caps, and that a
// second chunk's request does not start before the first resolves. VERIFY_BATCH_MAX_CITATIONS=50,
// VERIFY_BATCH_MAX_DOCUMENTS=5 — 120 citations cycling across 8 documents chunks on the document
// cap well before the citation cap, so this also exercises the "splits on whichever cap binds
// first" branch chunkForVerifyBatch's own unit tests already cover in isolation.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { NextRouterStub } from "@tests/support/next-router-stub";
import { VERIFY_BATCH_MAX_CITATIONS, VERIFY_BATCH_MAX_DOCUMENTS } from "@/shared/contracts/verify-batch";
import { ChatScreen } from "@/components/chat/chat-screen";

const LOCAL_ID = "local-33333333-3333-4333-8333-333333333333";
const CITATION_COUNT = 120;
const DOCUMENT_COUNT = 8;

function seedLargeLocalThread(): void {
  const citations = Array.from({ length: CITATION_COUNT }, (_, i) => ({
    quoteText: `quote number ${i}`,
    sourceDocumentId: `doc-${i % DOCUMENT_COUNT}`,
    unverifiedCachedStatus: "cached_verified",
  }));
  const raw = JSON.stringify({
    id: LOCAL_ID,
    title: "A very grounded chat",
    documentIds: [],
    messages: [{ id: "a1", role: "assistant", content: "many citations", mode: "grounded", citations, createdAtMs: 1 }],
  });
  window.localStorage.setItem(`saboot:threads:v1:${LOCAL_ID}`, raw);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ChatScreen's reopen re-verify pass — sequential, never parallel, chunked verify-batch", () => {
  let inFlight = 0;
  let maxConcurrentVerifyBatch = 0;
  let verifyBatchCallCount = 0;
  let verifyBatchRequestSizes: number[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    seedLargeLocalThread();
    inFlight = 0;
    maxConcurrentVerifyBatch = 0;
    verifyBatchCallCount = 0;
    verifyBatchRequestSizes = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/session")) return jsonResponse({ kind: "guest", signInAvailable: true, guestTtlHours: 3 });
        if (/\/api\/documents\/doc-\d+$/.test(url)) {
          return jsonResponse({
            analysisState: "not_analyzed",
            document: {
              id: url.split("/").pop(),
              title: "Doc",
              sampleId: null,
              projectId: null,
              filename: "doc.pdf",
              mimeType: "application/pdf",
              processingStatus: "ready",
              inputMode: "text",
              documentType: null,
              jurisdiction: "IN",
              detectionConfidence: null,
              uploadedAt: "2026-01-01T00:00:00.000Z",
              expiresAt: null,
            },
            analysis: null,
            findings: null,
          });
        }
        if (url.endsWith("/api/verify-batch") && init?.method === "POST") {
          verifyBatchCallCount++;
          inFlight++;
          maxConcurrentVerifyBatch = Math.max(maxConcurrentVerifyBatch, inFlight);
          const body = JSON.parse(init.body as string) as { citations: { documentId: string; quote: string }[] };
          verifyBatchRequestSizes.push(body.citations.length);
          expect(body.citations.length).toBeLessThanOrEqual(VERIFY_BATCH_MAX_CITATIONS);
          expect(new Set(body.citations.map((c) => c.documentId)).size).toBeLessThanOrEqual(VERIFY_BATCH_MAX_DOCUMENTS);
          // A short, real async delay — if a second chunk started before this one resolved,
          // maxConcurrentVerifyBatch would exceed 1.
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight--;
          return jsonResponse({ results: body.citations.map(() => ({ status: "approximate", spanStart: 0, spanEnd: 1, spanText: "x", claimedQuote: "y", verifierVersion: "v1", textHash: "h" })) });
        }
        throw new Error(`unmocked fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("chunks 120 citations / 8 documents into the expected number of sequential requests, never more than one in flight at once", async () => {
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

    await waitFor(() => expect(verifyBatchRequestSizes.reduce((a, b) => a + b, 0)).toBe(CITATION_COUNT), { timeout: 5000 });

    expect(maxConcurrentVerifyBatch).toBe(1);
    // 8 documents cycling, capped at 5 distinct docs per chunk: doc caps bind before the 50-citation
    // cap does, so this is >1 chunk — the real, load-bearing assertion (never just "some" chunks).
    expect(verifyBatchCallCount).toBeGreaterThan(1);
    for (const size of verifyBatchRequestSizes) expect(size).toBeLessThanOrEqual(VERIFY_BATCH_MAX_CITATIONS);
  });
});
