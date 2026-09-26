"use client";

// GET /api/documents?limit=50 -> DocumentListOutput, only fetched once the grounded branch is
// selected — no need to pay for the list on a from-scratch draft.

import type { z } from "zod";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { DocumentListOutput } from "@/shared/contracts/library";

type DocumentListResult = z.infer<typeof DocumentListOutput>;

export const DOCUMENTS_LIST_QUERY_KEY = ["documents", "list", { cursor: null }] as const;

export function useDocumentsListQuery(enabled: boolean): UseQueryResult<DocumentListResult> {
  return useQuery({
    queryKey: DOCUMENTS_LIST_QUERY_KEY,
    queryFn: () => apiFetchJson<DocumentListResult>("/api/documents?limit=50"),
    enabled,
    refetchOnWindowFocus: false,
  });
}
