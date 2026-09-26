/**
 * GET /api/documents/:id — the one fetcher every surface that reads a document shares: the chat
 * screen's attachment lookups, the analysis workspace and Draft's grounding-document lookups all
 * read this exact endpoint, into the same `["documents", id]` query-cache key. A second,
 * independently written fetch here risks drifting from the real route contract (encoding, parsing)
 * without any test catching it, since each caller's own tests exercise only its own copy.
 */

import { apiFetchJson } from "./client";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";

export function documentQueryKey(documentId: string) {
  return ["documents", documentId] as const;
}

export function fetchDocument(documentId: string): Promise<DocumentWithFindingsOutput> {
  return apiFetchJson<DocumentWithFindingsOutput>(`/api/documents/${encodeURIComponent(documentId)}`);
}

/**
 * A long staleTime once a document's own processing has settled (ready or extraction_failed): its
 * findings are re-verified server-side on every GET regardless, so a background refetch on
 * re-navigation would only be jarring, never more correct (the same reasoning
 * use-document-query.ts's refetchOnWindowFocus:false already applies). A still-`pending` document
 * keeps staleTime 0 — extraction is still running server-side and the next mount must see it finish.
 * Takes the last-fetched data directly (not the whole Query object) so callers don't need this
 * module's own opinion of TanStack Query's generic Query<> shape.
 */
export function documentStaleTime(data: DocumentWithFindingsOutput | undefined): number {
  if (!data || data.document.processingStatus === "pending") return 0;
  return Infinity;
}
