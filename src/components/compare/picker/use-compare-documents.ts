"use client";

/**
 * GET /api/documents?limit=50 -> DocumentListOutput, for the Compare picker's own list. A distinct
 * query key ("compare" rather than library.ts's own "library") — the two are separate
 * useInfiniteQuery/useQuery cache shapes under the same list endpoint, and sharing a key between
 * them would corrupt whichever reads second (the same reasoning use-library-list.ts's own header
 * comment gives). `retry: false` so a stubbed 429/500 surfaces immediately rather than sitting behind
 * the client-wide exponential backoff.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { DocumentListOutput as DocumentListOutputSchema } from "@/shared/contracts/library";

export type CompareDocumentListOutput = ReturnType<typeof DocumentListOutputSchema.parse>;

export function useCompareDocuments(): UseQueryResult<CompareDocumentListOutput> {
  return useQuery({
    queryKey: ["documents", "list", "compare"] as const,
    queryFn: () => apiFetchJson<CompareDocumentListOutput>("/api/documents?limit=50"),
    retry: false,
  });
}
