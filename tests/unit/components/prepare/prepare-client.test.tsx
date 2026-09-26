// The GET-gating rule: a document whose analysisState isn't "complete" never reaches
// POST …/prepare at all — asserted here by counting requests to a URL containing "/prepare",
// never by inspecting internal state.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { Toaster } from "@/components/ui/sonner";
import { PrepareClient } from "@/components/prepare/prepare-client";
import { NextRouterStub, fakeAppRouter } from "@tests/support/next-router-stub";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const FINDING = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  category: "obligation",
  explanation: "Pay rent monthly.",
  explanationProvenance: "ai_generated",
  lensExplanations: [{ lens: "tenant_about_to_sign", explanation: "Before signing, note the monthly rent.", explanationProvenance: "ai_generated" }],
  modelUsed: "gemini-2.5-flash",
  verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "Rent is due monthly.", verifierVersion: "v1", textHash: "hash-g" },
};

function documentFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "doc-1",
    title: "Lease.pdf",
    sampleId: null,
    projectId: null,
    filename: "lease.pdf",
    mimeType: "application/pdf",
    processingStatus: "ready",
    inputMode: "text",
    documentType: "leave_and_license",
    jurisdiction: "IN",
    detectionConfidence: null,
    uploadedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

function notAnalyzedResponse(processingStatus: "ready" | "extraction_failed" | "pending" = "ready") {
  return { analysisState: "not_analyzed", document: documentFixture({ processingStatus, documentType: null }), analysis: null, findings: null };
}

function completeResponse() {
  return {
    analysisState: "complete",
    document: documentFixture(),
    analysis: { id: "an-1", promptVersion: "v1", modelUsed: "gemini-2.5-flash", createdAt: "2026-01-01T00:00:00.000Z" },
    findings: [FINDING],
  };
}

function prepareCompleteFixture() {
  return {
    state: "complete",
    documentId: "doc-1",
    lens: { id: "tenant_about_to_sign", role: "tenant", stage: "about_to_sign" },
    lawyerQuestions: [
      {
        question: "When is rent due?",
        whyItMatters: "Late payment may attract a penalty.",
        provenance: "ai_generated",
        findingIds: [FINDING.id],
        findings: [{ id: FINDING.id, category: FINDING.category, verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "irrelevant", verifierVersion: "v1" } }],
      },
    ],
    checklist: [
      {
        item: "Note the rent due date.",
        provenance: "ai_generated",
        findingIds: [FINDING.id],
        findings: [{ id: FINDING.id, category: FINDING.category, verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "irrelevant", verifierVersion: "v1" } }],
      },
    ],
    modelUsed: "gemini-2.5-flash",
    promptVersion: "prepare-v4",
    markdown: "# Prepare for your lawyer",
  };
}

function renderPrepareClient(fetchImpl: typeof fetch) {
  vi.stubGlobal("navigator", { onLine: true, clipboard: { writeText: vi.fn() } });
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = fakeAppRouter();
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <LiveRegionProvider>
          <NextRouterStub pathname="/documents/doc-1/prepare" router={router}>
            <PrepareClient documentId="doc-1" initialLensParam={null} />
          </NextRouterStub>
        </LiveRegionProvider>
        <Toaster />
      </QueryClientProvider>,
    ),
  };
}

function countPrepareRequests(calls: unknown[][]): number {
  return calls.filter(([input]) => String(input).includes("/prepare")).length;
}

const PREPARING_LABEL = "Preparing your questions…";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PrepareClient — GET-gating", () => {
  it("not_analyzed: renders the EmptyState and makes zero requests to /prepare", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/documents/doc-1")) return jsonResponse(200, notAnalyzedResponse("ready"));
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    renderPrepareClient(fetchSpy as unknown as typeof fetch);

    await screen.findByText("This document hasn't been analysed yet.");
    expect(countPrepareRequests(fetchSpy.mock.calls)).toBe(0);
  });

  it("extraction_failed: renders distinct copy from not_analyzed, zero requests to /prepare", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/documents/doc-1")) return jsonResponse(200, notAnalyzedResponse("extraction_failed"));
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    renderPrepareClient(fetchSpy as unknown as typeof fetch);

    await screen.findByText("We couldn't read this document.");
    expect(screen.queryByText("This document hasn't been analysed yet.")).not.toBeInTheDocument();
    expect(countPrepareRequests(fetchSpy.mock.calls)).toBe(0);
  });
});

describe("PrepareClient — complete document, real POST …/prepare", () => {
  it("renders both lists once the model call resolves, and the lens select + export menu", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/prepare")) {
        // A real macrotask gap — otherwise a mocked round-trip resolves within the same microtask
        // flush RTL's render() already awaited, and the pending render is never actually painted.
        await new Promise((resolve) => setTimeout(resolve, 80));
        return jsonResponse(200, prepareCompleteFixture());
      }
      if (url.includes("/api/documents/doc-1")) return jsonResponse(200, completeResponse());
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? ""}`);
    });
    renderPrepareClient(fetchSpy as unknown as typeof fetch);

    expect(await screen.findByText(PREPARING_LABEL)).toBeInTheDocument();
    await screen.findByRole("heading", { level: 1, name: "Prepared for: Tenant, before signing" });
    expect(screen.getByText("When is rent due?")).toBeInTheDocument();
    expect(screen.getByText("Note the rent due date.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Viewing as" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(countPrepareRequests(fetchSpy.mock.calls)).toBe(1);
  });

  it("no_grounded_findings: renders its own distinct EmptyState, never an empty complete list", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/prepare")) return jsonResponse(200, { state: "no_grounded_findings", documentId: "doc-1" });
      if (url.includes("/api/documents/doc-1")) return jsonResponse(200, completeResponse());
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderPrepareClient(fetchSpy as unknown as typeof fetch);

    await screen.findByText("There's nothing verified enough in this document yet to prepare from.");
    expect(screen.queryByRole("heading", { name: "Questions to ask your lawyer" })).not.toBeInTheDocument();
  });

  it("503: shows RetryAfterNotice with the busy-providers copy and a manual retry, no automatic retry", async () => {
    let prepareCalls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/prepare")) {
        prepareCalls += 1;
        return jsonResponse(503, { error: { code: "UPSTREAM_UNAVAILABLE", message: "The AI providers are busy right now." } });
      }
      if (url.includes("/api/documents/doc-1")) return jsonResponse(200, completeResponse());
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderPrepareClient(fetchSpy as unknown as typeof fetch);

    await screen.findByText(/The AI providers are busy right now\./);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // retry: false — the query itself never auto-retries past the one request.
    await waitFor(() => expect(prepareCalls).toBe(1));
  });
});
