"use client";

/**
 * GET /api/documents/:id -> DocumentWithFindingsOutput. Refetch-on-focus is off: understand.get
 * already re-verifies server-side on every GET, so a background refetch mid-read would be jarring,
 * not more correct.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";

export function documentQueryKey(documentId: string) {
  return ["documents", documentId] as const;
}

/** Exported so the analyse/retry mutation's own post-422 discriminator reuses this exact fetch. */
export function fetchDocument(documentId: string): Promise<DocumentWithFindingsOutput> {
  return apiFetchJson<DocumentWithFindingsOutput>(`/api/documents/${encodeURIComponent(documentId)}`);
}

export function useDocumentQuery(documentId: string): UseQueryResult<DocumentWithFindingsOutput> {
  return useQuery({
    queryKey: documentQueryKey(documentId),
    queryFn: () => fetchDocument(documentId),
    refetchOnWindowFocus: false,
  });
}
