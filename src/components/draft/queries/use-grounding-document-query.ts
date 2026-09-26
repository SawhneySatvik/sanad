"use client";

/**
 * GET /api/documents/:id -> DocumentWithFindingsOutput, for Draft's own two uses of that endpoint:
 * the `?grounding=` deep-link resolve on /drafts/new, and the "Based on: <title>" secondary fetch on
 * /drafts/[id]. Same fetcher and query key (["documents", id]) the analysis workspace uses for this
 * endpoint (src/lib/api/documents.ts) — a distinct, competing fetch here would fork the cache.
 *
 * `retry: false` on both call sites: a 404 (foreign/missing/deleted document) must render its own
 * InlineNotice immediately, never after several silent retries, and a scripted 429/500/offline test
 * fixture must not be retried out from under the assertion that reads it.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { documentQueryKey, documentStaleTime, fetchDocument } from "@/lib/api/documents";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";

export function useGroundingDocumentQuery(documentId: string | null): UseQueryResult<DocumentWithFindingsOutput> {
  return useQuery({
    queryKey: documentQueryKey(documentId ?? ""),
    queryFn: () => fetchDocument(documentId!),
    enabled: documentId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: (query) => documentStaleTime(query.state.data),
  });
}
