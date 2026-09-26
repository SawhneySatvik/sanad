/**
 * Pure chunking for POST /api/verify-batch: splits a citation list into request-sized batches
 * respecting both of its caps (VERIFY_BATCH_MAX_CITATIONS per request, VERIFY_BATCH_MAX_DOCUMENTS
 * distinct documents per request), in original order. The caller sends each chunk sequentially,
 * never in parallel — parallel chunks would each compete separately for the shared per-IP 60/min
 * route budget.
 */

import { VERIFY_BATCH_MAX_CITATIONS, VERIFY_BATCH_MAX_DOCUMENTS } from "@/shared/contracts/verify-batch";

export interface ChunkableCitation {
  documentId: string;
}

/** Greedy, order-preserving: a chunk grows until adding the next citation would break either cap, then a new chunk starts. */
export function chunkForVerifyBatch<T extends ChunkableCitation>(citations: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentDocs = new Set<string>();

  for (const citation of citations) {
    const addsNewDoc = !currentDocs.has(citation.documentId);
    const overCitationCap = current.length + 1 > VERIFY_BATCH_MAX_CITATIONS;
    const overDocumentCap = addsNewDoc && currentDocs.size + 1 > VERIFY_BATCH_MAX_DOCUMENTS;

    if (current.length > 0 && (overCitationCap || overDocumentCap)) {
      chunks.push(current);
      current = [];
      currentDocs = new Set<string>();
    }

    current.push(citation);
    currentDocs.add(citation.documentId);
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
