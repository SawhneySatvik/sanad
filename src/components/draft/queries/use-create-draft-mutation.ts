"use client";

// POST /api/drafts -> DraftOutput. On success the caller seeds ["drafts", id] and navigates —
// nothing here decides routing, so the same hook works from a plain composer mount.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import type { CreateDraftInput } from "@/shared/contracts/drafts";
import { DraftOutput } from "@/shared/contracts/drafts";
import { draftQueryKey } from "./use-draft-query";

function createDraft(input: CreateDraftInput): Promise<DraftOutput> {
  return apiFetchJson<DraftOutput>("/api/drafts", { method: "POST", json: input });
}

export function useCreateDraftMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createDraft,
    onSuccess: (draft) => {
      queryClient.setQueryData(draftQueryKey(draft.id), draft);
    },
  });
}
