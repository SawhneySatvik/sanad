import { describe, expect, it } from "vitest";
import { comparisonToRow, documentToRow, draftToRow, threadToRow, localThreadToRow } from "@/components/library/library-row";

const FORBIDDEN_KEYS = ["verification", "status", "spanText", "claimedQuote"];

// Defensive prop-shape test (mirrors the contract test's intent at the component boundary): this
// screen must never become a place a status is displayed from anything but verify().
function assertNoVerificationKeys(row: object) {
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.keys(row)).not.toContain(key);
  }
}

describe("library-row mappers", () => {
  it("documentToRow carries no verification-shaped field", () => {
    const row = documentToRow({
      id: "d1", title: "Lease", filename: "lease.pdf", documentType: "leave_and_license",
      processingStatus: "ready", analysisState: "complete", inputMode: "native_document",
      sampleId: null, projectId: null, uploadedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z", expiresAt: null,
    });
    assertNoVerificationKeys(row);
    expect(row.href).toBe("/documents/d1");
    expect(row.updatedAtMs).toBe(Date.parse("2026-01-02T00:00:00.000Z"));
  });

  it("comparisonToRow, draftToRow and threadToRow all carry no verification-shaped field", () => {
    assertNoVerificationKeys(
      comparisonToRow({
        id: "c1", title: "A vs B", titleA: "A", titleB: "B", documentAId: "a", documentBId: "b",
        modelUsed: "gemini", projectId: null, createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z", expiresAt: null,
      }),
    );
    assertNoVerificationKeys(
      draftToRow({
        id: "dr1", title: "Draft", documentType: "nda", mode: "from_scratch", revisionCount: 2,
        projectId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", expiresAt: null,
      }),
    );
    assertNoVerificationKeys(
      threadToRow({ id: "t1", title: "Thread", projectId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    );
  });

  it("threadToRow falls back to 'New chat' for a null title", () => {
    const row = threadToRow({ id: "t1", title: null, projectId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(row.title).toBe("New chat");
  });

  it("localThreadToRow marks isLocal and never carries a projectId or expiresAt", () => {
    const row = localThreadToRow({ id: "local-abc", title: "Local", updatedAtMs: 1000 });
    expect(row.isLocal).toBe(true);
    expect(row.projectId).toBeNull();
    expect(row.expiresAt).toBeNull();
    expect(row.href).toBe("/chat/local-abc");
    assertNoVerificationKeys(row);
  });
});
