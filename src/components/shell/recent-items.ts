/**
 * RecentsList's own merge: the four server list endpoints plus a guest's local threads, combined
 * client-side into one array, sorted by last-activity descending and capped at 20. Only `GET
 * /api/threads` is ever empty for a guest; documents/comparisons/drafts return the guest's own real
 * rows, so a guest's RecentsList is those three lists plus local threads, never local threads alone.
 */

import { localThreadActivityMs, type LocalThreadEntry } from "./local-threads";

export const MAX_RECENT_ITEMS = 20;

/** The only fields this merge actually reads off a server list row — a structural subset every real
 * `*ListRowOutput` satisfies, so a caller can pass the exact contract type without this file needing
 * its own copy of each one (the contract row shapes are zod schema values with no matching `export
 * type`; deriving four `z.infer`s here just to re-narrow them back down would be circular). */
interface ListRow {
  id: string;
  title: string | null;
  updatedAt: string;
  expiresAt?: string | null;
}

export type RecentItemType = "document" | "comparison" | "draft" | "thread";

export interface RecentItem {
  /** The route id — for a local thread, the full "local-<uuid>" string already used in its href. */
  id: string;
  itemType: RecentItemType;
  isLocal: boolean;
  title: string;
  href: string;
  updatedAtMs: number;
  expiresAt: string | null;
}

function toRecentItem(itemType: RecentItemType, row: ListRow, href: string): RecentItem {
  return {
    id: row.id,
    itemType,
    isLocal: false,
    title: row.title ?? "New chat",
    href,
    updatedAtMs: Date.parse(row.updatedAt),
    expiresAt: row.expiresAt ?? null,
  };
}

export interface MergeRecentItemsInput {
  documents: ListRow[];
  comparisons: ListRow[];
  drafts: ListRow[];
  threads: ListRow[];
  localThreads: LocalThreadEntry[];
  now?: number;
}

export function mergeRecentItems(input: MergeRecentItemsInput): RecentItem[] {
  const now = input.now ?? Date.now();

  const items: RecentItem[] = [
    ...input.documents.map((row) => toRecentItem("document", row, `/documents/${row.id}`)),
    ...input.comparisons.map((row) => toRecentItem("comparison", row, `/compare/${row.id}`)),
    ...input.drafts.map((row) => toRecentItem("draft", row, `/drafts/${row.id}`)),
    ...input.threads.map((row) => toRecentItem("thread", row, `/chat/${row.id}`)),
    ...input.localThreads.map((entry, index) => ({
      id: entry.id,
      itemType: "thread" as const,
      isLocal: true,
      title: entry.thread.title || "New chat",
      href: `/chat/${entry.id}`,
      updatedAtMs: localThreadActivityMs(entry, index, now),
      expiresAt: null,
    })),
  ];

  return items.sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, MAX_RECENT_ITEMS);
}

/** "Deletes in about N h" — recomputed on every render, never cached stale. */
export function expiresInHoursLabel(expiresAt: string, now: number = Date.now()): string {
  const hours = Math.max(1, Math.round((Date.parse(expiresAt) - now) / 3_600_000));
  return `Deletes in about ${hours} h`;
}
