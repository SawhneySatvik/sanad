import { afterEach, describe, expect, it, vi } from "vitest";
import { documentQueryKey, documentStaleTime, fetchDocument } from "@/lib/api/documents";
import type { DocumentOutput, DocumentWithFindingsOutput } from "@/shared/contracts/documents";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function document(processingStatus: DocumentOutput["processingStatus"]): DocumentOutput {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "Lease",
    sampleId: null,
    projectId: null,
    filename: "lease.pdf",
    mimeType: "application/pdf",
    processingStatus,
    inputMode: "text",
    documentType: null,
    jurisdiction: "IN",
    detectionConfidence: null,
    uploadedAt: new Date().toISOString(),
    expiresAt: null,
  };
}

function unanalyzed(processingStatus: DocumentOutput["processingStatus"]): DocumentWithFindingsOutput {
  return { analysisState: "not_analyzed", document: document(processingStatus), analysis: null, findings: null };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("documentQueryKey", () => {
  it("keys by id under the shared 'documents' namespace every document reader uses", () => {
    expect(documentQueryKey("doc-1")).toEqual(["documents", "doc-1"]);
  });
});

describe("fetchDocument", () => {
  it("GETs /api/documents/:id, percent-encoding the id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(unanalyzed("ready")));
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchSpy);

    await fetchDocument("doc with space");

    expect(fetchSpy).toHaveBeenCalledWith("/api/documents/doc%20with%20space", expect.anything());
  });

  it("resolves with the parsed body", async () => {
    const body = unanalyzed("ready");
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    await expect(fetchDocument("doc-1")).resolves.toEqual(body);
  });
});

describe("documentStaleTime", () => {
  it("is 0 when there is no data yet", () => {
    expect(documentStaleTime(undefined)).toBe(0);
  });

  it("is 0 while the document is still pending — the next mount must see extraction finish", () => {
    expect(documentStaleTime(unanalyzed("pending"))).toBe(0);
  });

  it("is Infinity once processing has settled as ready — re-navigation reuses the cache instead of refetching", () => {
    expect(documentStaleTime(unanalyzed("ready"))).toBe(Infinity);
  });

  it("is Infinity once processing has settled as extraction_failed — nothing left to change without a new upload", () => {
    expect(documentStaleTime(unanalyzed("extraction_failed"))).toBe(Infinity);
  });
});
