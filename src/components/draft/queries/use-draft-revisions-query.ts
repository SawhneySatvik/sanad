"use client";

// GET /api/drafts/:id/revisions -> DraftRevisionsOutput — the whole chain, one request.
// refetchOnWindowFocus is off: a background refocus mid-review must never turn into a second
// /revisions request the "exactly one revisions request" gate would catch.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import type { DraftRevisionsResult } from "../types";

export function draftRevisionsQueryKey(draftId: string) {
  return ["drafts", draftId, "revisions"] as const;
}

export function fetchDraftRevisions(draftId: string): Promise<DraftRevisionsResult> {
  return apiFetchJson<DraftRevisionsResult>(`/api/drafts/${draftId}/revisions`);
}

export function useDraftRevisionsQuery(draftId: string): UseQueryResult<DraftRevisionsResult> {
  return useQuery({
    queryKey: draftRevisionsQueryKey(draftId),
    queryFn: () => fetchDraftRevisions(draftId),
    refetchOnWindowFocus: false,
  });
}
