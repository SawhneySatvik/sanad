// Chunking respects verify-batch's two independent caps (citation count, distinct document count)
// and never reorders — MessageList's "sequential, never parallel" chunking depends on this.

import { describe, expect, it } from "vitest";
import { VERIFY_BATCH_MAX_CITATIONS, VERIFY_BATCH_MAX_DOCUMENTS } from "@/shared/contracts/verify-batch";
import { chunkForVerifyBatch } from "@/lib/guest-threads/verify-batch-chunks";

function citation(documentId: string, index: number) {
  return { documentId, index };
}

describe("chunkForVerifyBatch", () => {
  it("a small list under both caps stays one chunk, order preserved", () => {
    const citations = [citation("doc-a", 0), citation("doc-b", 1), citation("doc-a", 2)];
    expect(chunkForVerifyBatch(citations)).toEqual([citations]);
  });

  it("an empty list produces zero chunks", () => {
    expect(chunkForVerifyBatch([])).toEqual([]);
  });

  it(`splits once the citation count would exceed ${VERIFY_BATCH_MAX_CITATIONS}, even for a single document`, () => {
    const citations = Array.from({ length: VERIFY_BATCH_MAX_CITATIONS + 1 }, (_, i) => citation("doc-a", i));
    const chunks = chunkForVerifyBatch(citations);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(VERIFY_BATCH_MAX_CITATIONS);
    expect(chunks[1]).toHaveLength(1);
    // Order preserved across the split.
    expect(chunks.flat().map((c) => c.index)).toEqual(citations.map((c) => c.index));
  });

  it(`splits once distinct documents would exceed ${VERIFY_BATCH_MAX_DOCUMENTS}, even with few citations`, () => {
    const citations = Array.from({ length: VERIFY_BATCH_MAX_DOCUMENTS + 1 }, (_, i) => citation(`doc-${i}`, i));
    const chunks = chunkForVerifyBatch(citations);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(VERIFY_BATCH_MAX_DOCUMENTS);
    expect(chunks[1]).toHaveLength(1);
  });

  it("a repeated document within the same chunk doesn't count twice against the document cap", () => {
    const citations = [
      ...Array.from({ length: VERIFY_BATCH_MAX_DOCUMENTS }, (_, i) => citation(`doc-${i}`, i)),
      citation("doc-0", 999), // repeats an already-counted document — must still fit in chunk 1
    ];
    const chunks = chunkForVerifyBatch(citations);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(VERIFY_BATCH_MAX_DOCUMENTS + 1);
  });

  it("a real oversized guest thread (120 citations across 8 documents) chunks into the expected sequential batches respecting both caps", () => {
    const citations = Array.from({ length: 120 }, (_, i) => citation(`doc-${i % 8}`, i));
    const chunks = chunkForVerifyBatch(citations);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(VERIFY_BATCH_MAX_CITATIONS);
      expect(new Set(chunk.map((c) => c.documentId)).size).toBeLessThanOrEqual(VERIFY_BATCH_MAX_DOCUMENTS);
    }
    expect(chunks.flat().map((c) => c.index)).toEqual(citations.map((c) => c.index));
  });
});
