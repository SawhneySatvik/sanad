"use client";

/**
 * PATCH /api/drafts/:id — renames the whole revision chain in one transaction. The response is
 * DraftListRowOutput (library.rename's own row shape), not DraftWithSectionsOutput, so the
 * currently-loaded draft's cache entry is patched directly from the title just submitted rather than
 * from the response body — the two shapes disagree on almost every other field. Never
 * prefix-invalidates ["drafts"]: that would also match ["drafts", id, "revisions"], forcing a second,
 * unwanted /revisions request for a field (title) that endpoint doesn't even carry.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { DraftWithSectionsOutput } from "@/shared/contracts/drafts";
import { draftQueryKey } from "./use-draft-query";

export function useRenameDraftMutation(draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (title: string) => {
      await apiFetch(`/api/drafts/${draftId}`, { method: "PATCH", json: { title } });
      return title;
    },
    onSuccess: (title) => {
      queryClient.setQueryData<DraftWithSectionsOutput>(draftQueryKey(draftId), (old) => (old ? { ...old, title } : old));
    },
  });
}
