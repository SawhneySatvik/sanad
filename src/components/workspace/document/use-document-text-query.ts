"use client";

/**
 * GET /api/documents/:id/text -> DocumentTextOutput. `staleTime: Infinity` — canonical text is
 * immutable once extracted, no re-extraction path exists over an existing row. Only fetched once
 * `processingStatus === "ready"` (a "pending"/"extraction_failed" document has no text to fetch at
 * all, per the workspace's own Data section) — `enabled` below is the caller's own gate for that.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { DocumentTextOutput } from "@/shared/contracts/document-text";

export function documentTextQueryKey(documentId: string) {
  return ["documents", documentId, "text"] as const;
}

export function useDocumentTextQuery(documentId: string, enabled: boolean): UseQueryResult<DocumentTextOutput> {
  return useQuery({
    queryKey: documentTextQueryKey(documentId),
    queryFn: () => apiFetchJson<DocumentTextOutput>(`/api/documents/${encodeURIComponent(documentId)}/text`),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
