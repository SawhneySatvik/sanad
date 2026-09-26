"use client";

/**
 * GET /api/documents/:id -> DocumentWithFindingsOutput, for Draft's own two uses of that endpoint:
 * the `?grounding=` deep-link resolve on /drafts/new, and the "Based on: <title>" secondary fetch on
 * /drafts/[id]. Same query key (["documents", id]) the analysis workspace already uses for this
 * endpoint — a distinct, competing fetcher under a different key would fork the cache; this one
 * mirrors that shape exactly instead of importing a query hook from the workspace surface
 * (src/components/workspace/**) for this one field, the same deliberately minimal, local copy
 * save-to-project-dialog.tsx already builds for its own picker gap.
 *
 * `retry: false` on both call sites: a 404 (foreign/missing/deleted document) must render its own
 * InlineNotice immediately, never after several silent retries, and a scripted 429/500/offline test
 * fixture must not be retried out from under the assertion that reads it.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";

export function groundingDocumentQueryKey(documentId: string) {
  return ["documents", documentId] as const;
}

export function fetchGroundingDocument(documentId: string): Promise<DocumentWithFindingsOutput> {
  return apiFetchJson<DocumentWithFindingsOutput>(`/api/documents/${documentId}`);
}

export function useGroundingDocumentQuery(documentId: string | null): UseQueryResult<DocumentWithFindingsOutput> {
  return useQuery({
    queryKey: groundingDocumentQueryKey(documentId ?? ""),
    queryFn: () => fetchGroundingDocument(documentId!),
    enabled: documentId !== null,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
