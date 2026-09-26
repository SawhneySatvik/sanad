// The proactive import-caps counter, plus the parity pin against the real server constant
// (a client bundle may never import server code, so caps.ts carries its own literal copy).

import { describe, expect, it } from "vitest";
import { MAX_IMPORTED_DOCUMENTS as SERVER_MAX_IMPORTED_DOCUMENTS } from "@/server/services/ask";
import { createEmptyThread, appendMessage, type GuestMessage } from "@/lib/guest-thread-store";
import { importCapsUsage, isWithinImportCaps, MAX_IMPORTED_CITATIONS, MAX_IMPORTED_DOCUMENTS } from "@/lib/guest-threads/caps";

function assistantWithCitations(id: string, citations: { quoteText: string; sourceDocumentId: string; unverifiedCachedStatus: "cached_verified" }[]): GuestMessage {
  return { id, role: "assistant", content: "answer", mode: "grounded", citations, createdAtMs: Date.now() };
}

describe("caps.ts mirrors the live server constant", () => {
  it("MAX_IMPORTED_DOCUMENTS equals ask.ts's own MAX_IMPORTED_DOCUMENTS", () => {
    expect(MAX_IMPORTED_DOCUMENTS).toBe(SERVER_MAX_IMPORTED_DOCUMENTS);
  });
});

describe("importCapsUsage", () => {
  it("counts citations across every message and distinct documents across attachments + citation sources", () => {
    let thread = createEmptyThread("t", "T");
    thread = { ...thread, documentIds: ["doc-a"] };
    thread = appendMessage(
      thread,
      assistantWithCitations("m1", [
        { quoteText: "q1", sourceDocumentId: "doc-a", unverifiedCachedStatus: "cached_verified" },
        { quoteText: "q2", sourceDocumentId: "doc-b", unverifiedCachedStatus: "cached_verified" },
      ]),
    );

    const usage = importCapsUsage(thread);
    expect(usage.citations).toBe(2);
    expect(usage.documents).toBe(2); // doc-a, doc-b — doc-a isn't double-counted
  });

  it("the unlinked sentinel ('') never counts as a document", () => {
    let thread = createEmptyThread("t", "T");
    thread = appendMessage(
      thread,
      assistantWithCitations("m1", [{ quoteText: "q1", sourceDocumentId: "", unverifiedCachedStatus: "cached_verified" }]),
    );

    expect(importCapsUsage(thread)).toEqual({ citations: 1, documents: 0 });
  });

  it("isWithinImportCaps is true right at the boundary, false one past it", () => {
    const citations = Array.from({ length: MAX_IMPORTED_CITATIONS }, (_, i) => ({
      quoteText: `q${i}`,
      sourceDocumentId: "doc-a",
      unverifiedCachedStatus: "cached_verified" as const,
    }));
    let thread = createEmptyThread("t", "T");
    thread = appendMessage(thread, assistantWithCitations("m1", citations));
    expect(isWithinImportCaps(thread)).toBe(true);

    thread = appendMessage(
      thread,
      assistantWithCitations("m2", [{ quoteText: "one more", sourceDocumentId: "doc-a", unverifiedCachedStatus: "cached_verified" }]),
    );
    expect(isWithinImportCaps(thread)).toBe(false);
  });

  it("the document cap is independently enforced from the citation cap", () => {
    const citations = Array.from({ length: MAX_IMPORTED_DOCUMENTS + 1 }, (_, i) => ({
      quoteText: `q${i}`,
      sourceDocumentId: `doc-${i}`,
      unverifiedCachedStatus: "cached_verified" as const,
    }));
    let thread = createEmptyThread("t", "T");
    thread = appendMessage(thread, assistantWithCitations("m1", citations));
    expect(isWithinImportCaps(thread)).toBe(false);
  });
});
