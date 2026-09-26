"use client";

/**
 * GET /api/documents/:id -> DocumentWithFindingsOutput. Refetch-on-focus is off: understand.get
 * already re-verifies server-side on every GET, so a background refetch mid-read would be jarring,
 * not more correct — the same reasoning behind this query's own staleTime below.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { documentQueryKey, documentStaleTime, fetchDocument } from "@/lib/api/documents";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";

/** Re-exported so the analyse/retry mutation's own post-422 discriminator reuses this exact fetch and key. */
export { documentQueryKey, fetchDocument };

export function useDocumentQuery(documentId: string): UseQueryResult<DocumentWithFindingsOutput> {
  return useQuery({
    queryKey: documentQueryKey(documentId),
    queryFn: () => fetchDocument(documentId),
    refetchOnWindowFocus: false,
    staleTime: (query) => documentStaleTime(query.state.data),
  });
}
