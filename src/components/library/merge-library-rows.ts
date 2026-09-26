/**
 * The "All" tab's cross-list merge, via a watermark rule. Four independently-paged lists
 * plus a guest's fully-loaded local threads are combined newest-first, but a row is only ever shown
 * once nothing still-unfetched could sort ahead of it: the watermark is the oldest `updatedAt` among
 * the last loaded row of every list that still has a next page, and no row older than that renders —
 * otherwise "Load more" could later reveal a newer row that belongs above one already painted.
 */

import type { LibraryRow } from "./library-row";

export interface MergeableList {
  rows: LibraryRow[];
  /** True once this list's own cursor is exhausted (nextCursor was null) — false while more may exist. */
  exhausted: boolean;
}

export interface MergeLibraryRowsInput {
  lists: MergeableList[];
  /** A guest's local threads — always fully loaded, never itself a paging source. */
  localRows?: LibraryRow[];
}

export interface MergeLibraryRowsResult {
  rows: LibraryRow[];
  /** True while at least one list still has an unfetched next page — drives "Load more". */
  hasMore: boolean;
}

function watermarkOf(lists: MergeableList[]): number | null {
  const frontiers = lists
    .filter((list) => !list.exhausted && list.rows.length > 0)
    .map((list) => list.rows[list.rows.length - 1].updatedAtMs);
  if (frontiers.length === 0) return null;
  return Math.min(...frontiers);
}

export function mergeLibraryRows({ lists, localRows = [] }: MergeLibraryRowsInput): MergeLibraryRowsResult {
  const watermark = watermarkOf(lists);
  const all = [...lists.flatMap((list) => list.rows), ...localRows];
  const visible = watermark === null ? all : all.filter((row) => row.updatedAtMs >= watermark);

  visible.sort((a, b) => {
    if (b.updatedAtMs !== a.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
    // Mirrors the server's own DESC,DESC tiebreak (updated_at desc, id desc) closely enough for a
    // stable render order — exact ties across four independently-paged lists are rare in practice.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  return { rows: visible, hasMore: lists.some((list) => !list.exhausted) };
}
