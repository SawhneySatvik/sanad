"use client";

/**
 * Resolves a citation's source-document label for CitationChip's own aria-label ("Jump to citation
 * in <label>, verified") — AskCitationOutput carries no filename/title of its own. Reuses the
 * ordinary ["documents", id] TanStack cache key every other screen warms (upload success, the
 * ?attach= GET), so a document already known this session resolves instantly with no extra
 * request.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchDocument } from "./api";

const FALLBACK_LABEL = "your document";

export function useDocumentLabel(documentId: string | null): string {
  const { data } = useQuery({
    queryKey: ["documents", documentId],
    queryFn: () => fetchDocument(documentId as string),
    enabled: documentId != null && documentId !== "",
    staleTime: Infinity,
    retry: false,
  });
  if (!documentId) return FALLBACK_LABEL;
  return data?.document.title || data?.document.filename || FALLBACK_LABEL;
}
