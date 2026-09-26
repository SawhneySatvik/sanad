"use client";

/**
 * One keyset-paged list per kind, `{ items, nextCursor }` (docs/API.md). Query key is sub-keyed
 * under `"library"` — `[kind, "list", "library"]`, never the bare `[kind, "list"]` the sidebar's
 * `useRecents` (src/components/shell/use-recents.ts) already owns as a plain, single-page
 * `useQuery`. Sharing the exact same key between a `useInfiniteQuery` (pages-shaped cache) and a
 * plain `useQuery` (flat-shaped cache) would corrupt whichever one reads second; invalidating the
 * bare `[kind, "list"]` prefix still refreshes both, since TanStack Query's default invalidation
 * match is "starts with this key," not "equals it."
 *
 * `retry: false`: the default client-wide retry (3 attempts, exponential backoff) would hold a
 * stubbed 429/500 in flight for several seconds before this list's own inline ErrorState ever
 * renders — this screen needs the first failure to surface immediately, same reasoning
 * use-session.ts already states for the session query.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { apiFetchJson, ApiError } from "@/lib/api";
import { ComparisonListRowOutput, DocumentListRowOutput, DraftListRowOutput, ThreadListRowOutput } from "@/shared/contracts/library";
import { comparisonToRow, documentToRow, draftToRow, threadToRow, type LibraryRow } from "./library-row";

export type LibraryKind = "documents" | "comparisons" | "drafts" | "threads";

const PATH_BY_KIND: Record<LibraryKind, string> = {
  documents: "/api/documents",
  comparisons: "/api/comparisons",
  drafts: "/api/drafts",
  threads: "/api/threads",
};

interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
}

async function fetchListPage<T>(path: string, cursor: string | undefined): Promise<ListPage<T>> {
  const query = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : "?limit=50";
  return apiFetchJson<ListPage<T>>(`${path}${query}`);
}

export interface LibraryListState {
  rows: LibraryRow[];
  /** True once this list's own cursor is exhausted — false while loading or more pages remain. */
  exhausted: boolean;
  isLoading: boolean;
  isError: boolean;
  errorCode?: ApiError["code"];
  retryAfterSeconds?: number;
  fetchNextPage: () => void;
}

function useLibraryKindList<T>(kind: LibraryKind, mapRow: (row: T) => LibraryRow): LibraryListState {
  const path = PATH_BY_KIND[kind];
  const query = useInfiniteQuery({
    queryKey: [kind, "list", "library"] as const,
    queryFn: ({ pageParam }) => fetchListPage<T>(path, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: ListPage<T>) => lastPage.nextCursor ?? undefined,
    retry: false,
  });

  const rows = (query.data?.pages ?? []).flatMap((page) => page.items.map(mapRow));
  const error = query.error instanceof ApiError ? query.error : undefined;

  return {
    rows,
    exhausted: query.data !== undefined && !query.hasNextPage,
    isLoading: query.isLoading,
    isError: query.isError,
    errorCode: error?.code,
    retryAfterSeconds: error?.retryAfterSeconds,
    fetchNextPage: () => void query.fetchNextPage(),
  };
}

export function useDocumentLibraryList(): LibraryListState {
  return useLibraryKindList<ReturnType<typeof DocumentListRowOutput.parse>>("documents", documentToRow);
}
export function useComparisonLibraryList(): LibraryListState {
  return useLibraryKindList<ReturnType<typeof ComparisonListRowOutput.parse>>("comparisons", comparisonToRow);
}
export function useDraftLibraryList(): LibraryListState {
  return useLibraryKindList<ReturnType<typeof DraftListRowOutput.parse>>("drafts", draftToRow);
}
export function useThreadLibraryList(): LibraryListState {
  return useLibraryKindList<ReturnType<typeof ThreadListRowOutput.parse>>("threads", threadToRow);
}
