"use client";

/**
 * GET /api/comparisons/:id -> ComparisonWithChangesOutput. Re-verifies both sides fresh on every
 * call (compare.ts's get()) — no refetch-on-focus, same reasoning as the workspace's own
 * useDocumentQuery: a background refetch mid-read would move marks under the reader.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";

export function comparisonQueryKey(id: string) {
  return ["comparisons", id] as const;
}

export function useComparisonQuery(id: string): UseQueryResult<ComparisonWithChangesOutput> {
  return useQuery({
    queryKey: comparisonQueryKey(id),
    queryFn: () => apiFetchJson<ComparisonWithChangesOutput>(`/api/comparisons/${id}`),
    refetchOnWindowFocus: false,
    // The client-wide default (3 retries, exponential backoff) would hold a 404 in flight for
    // several seconds before this screen's own ErrorState ever renders — same reasoning
    // use-session.ts's own header comment gives.
    retry: false,
  });
}
