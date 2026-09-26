"use client";

/**
 * The four server list queries plus a guest's local threads, merged into RecentsList's own
 * item shape. A list query that fails simply contributes nothing this refresh (its own data stays
 * `undefined`, which `mergeRecentItems` treats as an empty array) — chrome must never block on a
 * list read the way a page-level ErrorState would.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { z } from "zod";
import { apiFetchJson } from "@/lib/api";
import {
  ComparisonListOutput,
  DocumentListOutput,
  DraftListOutput,
  ThreadListOutput,
} from "@/shared/contracts/library";
import { mergeRecentItems, type RecentItem } from "./recent-items";
import { useLocalThreads } from "./local-threads";

export type RecentListKind = "documents" | "comparisons" | "drafts" | "threads";

// Same z.infer note as recent-items.ts: these are zod schema values with no matching `export type`.
type DocumentList = z.infer<typeof DocumentListOutput>;
type ComparisonList = z.infer<typeof ComparisonListOutput>;
type DraftList = z.infer<typeof DraftListOutput>;
type ThreadList = z.infer<typeof ThreadListOutput>;

function useListQuery<T>(kind: RecentListKind, path: string): UseQueryResult<T> {
  return useQuery({
    queryKey: [kind, "list"],
    queryFn: () => apiFetchJson<T>(path),
  });
}

export interface UseRecentsResult {
  items: RecentItem[];
  isLoading: boolean;
}

export function useRecents(): UseRecentsResult {
  const documents = useListQuery<DocumentList>("documents", "/api/documents");
  const comparisons = useListQuery<ComparisonList>("comparisons", "/api/comparisons");
  const drafts = useListQuery<DraftList>("drafts", "/api/drafts");
  const threads = useListQuery<ThreadList>("threads", "/api/threads");
  // Client-only mount gate (the hydration hazard: there's no localStorage to read on the server, so
  // the server snapshot is always empty).
  const localThreads = useLocalThreads();

  const items = mergeRecentItems({
    documents: documents.data?.items ?? [],
    comparisons: comparisons.data?.items ?? [],
    drafts: drafts.data?.items ?? [],
    threads: threads.data?.items ?? [],
    localThreads,
  });

  return {
    items,
    isLoading: documents.isLoading || comparisons.isLoading || drafts.isLoading || threads.isLoading,
  };
}
