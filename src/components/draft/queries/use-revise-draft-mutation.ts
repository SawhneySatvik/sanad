"use client";

// POST /api/drafts/:id/revise -> DraftOutput. Seeds the new revision's own cache entry and marks the
// parent's revisions list stale WITHOUT an eager background refetch (refetchType: "none") — the
// parent route is about to be navigated away from, and an eager refetch there would be a second,
// unwanted /revisions request racing the new route's own first one.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import type { ReviseDraftInput } from "@/shared/contracts/drafts";
import { DraftOutput } from "@/shared/contracts/drafts";
import { draftQueryKey } from "./use-draft-query";
import { draftRevisionsQueryKey } from "./use-draft-revisions-query";

function reviseDraft(parentDraftId: string, input: ReviseDraftInput): Promise<DraftOutput> {
  return apiFetchJson<DraftOutput>(`/api/drafts/${parentDraftId}/revise`, { method: "POST", json: input });
}

export function useReviseDraftMutation(parentDraftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviseDraftInput) => reviseDraft(parentDraftId, input),
    onSuccess: (draft) => {
      queryClient.setQueryData(draftQueryKey(draft.id), draft);
      void queryClient.invalidateQueries({ queryKey: draftRevisionsQueryKey(parentDraftId), refetchType: "none" });
    },
  });
}
