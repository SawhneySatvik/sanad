"use client";

/**
 * POST /api/documents/:id/prepare -> PrepareOutput. The lens is part of the query key (F2's own
 * "a lens change is a genuinely different, chargeable result" gate) — never served from a stale
 * cache entry for a different lens, but a lens switched back to within the same session is served
 * from cache without a second charge (staleTime: Infinity, retry: false — every re-fetch here is
 * either a genuine lens change or an explicit "Try again" click, never a background refetch spending
 * a real model call the caller never asked for).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson, ApiError } from "@/lib/api";
import type { PrepareOutput } from "@/shared/contracts/prepare";

function postPrepare(documentId: string, lens: string | null): Promise<PrepareOutput> {
  const query = lens ? `?lens=${encodeURIComponent(lens)}` : "";
  return apiFetchJson<PrepareOutput>(`/api/documents/${documentId}/prepare${query}`, { method: "POST" });
}

// Reachable only via a hand-edited URL: client-side validation already keeps `lens` valid for this
// document's own type before this ever fires. One retry, with the lens omitted entirely (never the
// same lens that just failed) — never a second retry, so a persistently-wrong lens can't loop.
async function fetchPrepare(documentId: string, lens: string | null): Promise<PrepareOutput> {
  try {
    return await postPrepare(documentId, lens);
  } catch (error) {
    if (error instanceof ApiError && error.code === "VALIDATION_FAILED" && lens !== null) {
      return await postPrepare(documentId, null);
    }
    throw error;
  }
}

export function prepareQueryKey(documentId: string, lens: string | null) {
  return ["prepare", documentId, lens ?? "__default__"] as const;
}

export function usePrepareQuery(documentId: string, lens: string | null, enabled: boolean): UseQueryResult<PrepareOutput> {
  return useQuery({
    queryKey: prepareQueryKey(documentId, lens),
    queryFn: () => fetchPrepare(documentId, lens),
    enabled,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
