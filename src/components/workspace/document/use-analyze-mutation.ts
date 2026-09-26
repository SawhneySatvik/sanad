"use client";

/**
 * POST /api/documents/:id/analyze — both "Analyse now" (not_analyzed) and "Retry analysis" (a
 * pending/ready document whose earlier analyze call failed) are the same idempotent call
 * (understand.analyzeDocument's own insertAnalysisIfAbsent makes a concurrent double-click safe
 * server-side; no client-side lock is needed).
 *
 * The too-long trap: a 422 from this route can mean two different
 * things and the server's own `reason` enum isn't pinned for the over-budget throw site
 * specifically, so this hook never branches on `reason` here. Instead, on ANY 422, it refetches the
 * document and reads
 * `processingStatus`: still "ready" -> the too-long, no-action case (remembered for this session, so
 * the button never reappears on a later render); now "extraction_failed" -> the row transitioned
 * there server-side, and the fresh document (which already reflects that) is written to the cache.
 */

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetchJson, ApiError } from "@/lib/api";
import type { DocumentWithFindingsOutput } from "@/shared/contracts/documents";
import { documentQueryKey, fetchDocument } from "./use-document-query";

function analyzeDocument(documentId: string): Promise<DocumentWithFindingsOutput> {
  return apiFetchJson<DocumentWithFindingsOutput>(`/api/documents/${encodeURIComponent(documentId)}/analyze`, { method: "POST" });
}

export interface UseAnalyzeMutationResult {
  analyse: () => void;
  isAnalysing: boolean;
  error: ApiError | null;
  /** Set once a 422 is confirmed to be the too-long case; never reset within this mount. */
  tooLong: boolean;
}

export function useAnalyzeMutation(documentId: string): UseAnalyzeMutationResult {
  const queryClient = useQueryClient();
  const [tooLong, setTooLong] = useState(false);

  const mutation = useMutation({
    mutationFn: () => analyzeDocument(documentId),
    onSuccess: (data) => {
      queryClient.setQueryData(documentQueryKey(documentId), data);
    },
    onError: async (error: unknown) => {
      if (!(error instanceof ApiError) || error.code !== "INVALID_DOCUMENT") return;
      const fresh = await fetchDocument(documentId);
      if (fresh.analysisState === "not_analyzed" && fresh.document.processingStatus === "ready") {
        setTooLong(true);
      } else {
        queryClient.setQueryData(documentQueryKey(documentId), fresh);
      }
    },
  });

  const analyse = useCallback(() => mutation.mutate(), [mutation]);

  return {
    analyse,
    isAnalysing: mutation.isPending,
    error: mutation.error instanceof ApiError ? mutation.error : null,
    tooLong,
  };
}
