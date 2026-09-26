import { describe, expect, it } from "vitest";
import { mergeLibraryRows } from "@/components/library/merge-library-rows";
import type { LibraryRow } from "@/components/library/library-row";

function row(id: string, updatedAtMs: number): LibraryRow {
  return {
    itemType: "document",
    id,
    title: id,
    href: `/documents/${id}`,
    updatedAtMs,
    createdAtMs: updatedAtMs,
    expiresAt: null,
    projectId: null,
    isLocal: false,
    documentType: null,
    analysisState: "complete",
    processingStatus: "ready",
    inputMode: "text",
    sampleId: null,
  };
}

describe("mergeLibraryRows", () => {
  it("merges every fully-exhausted list in updatedAt order with no watermark to apply", () => {
    const result = mergeLibraryRows({
      lists: [
        { rows: [row("a", 300), row("b", 100)], exhausted: true },
        { rows: [row("c", 200)], exhausted: true },
      ],
    });
    expect(result.rows.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(result.hasMore).toBe(false);
  });

  it("withholds a row older than the watermark, even from an already-exhausted list", () => {
    // List A still has an unfetched page behind its last-loaded row at 200 — that is the
    // watermark. List B is exhausted, but its own row at 50 is older than the watermark, so it
    // must not render yet: an undiscovered row from A could still sort between 200 and 50.
    const result = mergeLibraryRows({
      lists: [
        { rows: [row("a1", 500), row("a2", 200)], exhausted: false },
        { rows: [row("b1", 50)], exhausted: true },
      ],
    });
    expect(result.rows.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(result.hasMore).toBe(true);
  });

  it("includes a row exactly at the watermark, never excludes the boundary itself", () => {
    const result = mergeLibraryRows({
      lists: [{ rows: [row("a", 100)], exhausted: false }],
    });
    expect(result.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("after Load More exhausts every list, the previously-withheld row appears", () => {
    const firstPass = mergeLibraryRows({
      lists: [
        { rows: [row("a1", 500), row("a2", 200)], exhausted: false },
        { rows: [row("b1", 50)], exhausted: true },
      ],
    });
    expect(firstPass.rows.map((r) => r.id)).toEqual(["a1", "a2"]);

    const secondPass = mergeLibraryRows({
      lists: [
        { rows: [row("a1", 500), row("a2", 200), row("a3", 10)], exhausted: true },
        { rows: [row("b1", 50)], exhausted: true },
      ],
    });
    expect(secondPass.rows.map((r) => r.id)).toEqual(["a1", "a2", "b1", "a3"]);
    expect(secondPass.hasMore).toBe(false);
  });

  it("mixes in fully-loaded local rows, subject to the same watermark", () => {
    const result = mergeLibraryRows({
      lists: [{ rows: [row("a", 500), row("b", 200)], exhausted: false }],
      localRows: [row("local-old", 10), row("local-new", 300)],
    });
    // watermark = 200 (a's list still has more behind it) — local-old (10) is withheld.
    expect(result.rows.map((r) => r.id)).toEqual(["a", "local-new", "b"]);
  });

  it("an empty list set merges to nothing, no error", () => {
    const result = mergeLibraryRows({ lists: [] });
    expect(result.rows).toEqual([]);
    expect(result.hasMore).toBe(false);
  });
});
