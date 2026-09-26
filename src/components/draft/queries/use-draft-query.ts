"use client";

// GET /api/drafts/:id -> DraftWithSectionsOutput.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { DraftWithSectionsOutput } from "@/shared/contracts/drafts";

export function draftQueryKey(draftId: string) {
  return ["drafts", draftId] as const;
}

export function fetchDraft(draftId: string): Promise<DraftWithSectionsOutput> {
  return apiFetchJson<DraftWithSectionsOutput>(`/api/drafts/${draftId}`);
}

export function useDraftQuery(draftId: string): UseQueryResult<DraftWithSectionsOutput> {
  return useQuery({
    queryKey: draftQueryKey(draftId),
    queryFn: () => fetchDraft(draftId),
    refetchOnWindowFocus: false,
  });
}
