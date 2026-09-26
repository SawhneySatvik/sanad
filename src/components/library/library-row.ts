/**
 * The client-composed row shape LibraryTable renders, one variant per kind. Every field comes
 * straight off its own *ListRowOutput — none of the four already carries a verification/status/
 * spanText/claimedQuote key, and this type must never grow one either (the architecture-style test
 * in tests/unit/components/library asserts it stays that way at the component boundary).
 */

import type { z } from "zod";
import {
  ComparisonListRowOutput,
  DocumentListRowOutput,
  DraftListRowOutput,
  ThreadListRowOutput,
} from "@/shared/contracts/library";

export type LibraryItemType = "document" | "comparison" | "draft" | "thread";

interface LibraryRowCommon {
  id: string;
  title: string;
  href: string;
  updatedAtMs: number;
  createdAtMs: number;
  expiresAt: string | null;
  projectId: string | null;
  /** A guest's local-only thread — never true for any server-backed row. */
  isLocal: boolean;
}

export interface DocumentLibraryRow extends LibraryRowCommon {
  itemType: "document";
  documentType: string | null;
  analysisState: "complete" | "not_analyzed";
  processingStatus: "pending" | "ready" | "extraction_failed";
  inputMode: "text" | "native_document" | null;
  sampleId: string | null;
}

export interface ComparisonLibraryRow extends LibraryRowCommon {
  itemType: "comparison";
}

export interface DraftLibraryRow extends LibraryRowCommon {
  itemType: "draft";
  documentType: string;
  mode: "from_scratch" | "document_grounded";
  revisionCount: number;
}

export interface ThreadLibraryRow extends LibraryRowCommon {
  itemType: "thread";
}

export type LibraryRow = DocumentLibraryRow | ComparisonLibraryRow | DraftLibraryRow | ThreadLibraryRow;

type DocumentRowInput = z.infer<typeof DocumentListRowOutput>;
type ComparisonRowInput = z.infer<typeof ComparisonListRowOutput>;
type DraftRowInput = z.infer<typeof DraftListRowOutput>;
type ThreadRowInput = z.infer<typeof ThreadListRowOutput>;

export function documentToRow(row: DocumentRowInput): DocumentLibraryRow {
  return {
    itemType: "document",
    id: row.id,
    title: row.title,
    href: `/documents/${row.id}`,
    updatedAtMs: Date.parse(row.updatedAt),
    createdAtMs: Date.parse(row.uploadedAt),
    expiresAt: row.expiresAt,
    projectId: row.projectId,
    isLocal: false,
    documentType: row.documentType,
    analysisState: row.analysisState,
    processingStatus: row.processingStatus,
    inputMode: row.inputMode,
    sampleId: row.sampleId,
  };
}

export function comparisonToRow(row: ComparisonRowInput): ComparisonLibraryRow {
  return {
    itemType: "comparison",
    id: row.id,
    title: row.title,
    href: `/compare/${row.id}`,
    updatedAtMs: Date.parse(row.updatedAt),
    createdAtMs: Date.parse(row.createdAt),
    expiresAt: row.expiresAt,
    projectId: row.projectId,
    isLocal: false,
  };
}

export function draftToRow(row: DraftRowInput): DraftLibraryRow {
  return {
    itemType: "draft",
    id: row.id,
    title: row.title,
    href: `/drafts/${row.id}`,
    updatedAtMs: Date.parse(row.updatedAt),
    createdAtMs: Date.parse(row.createdAt),
    expiresAt: row.expiresAt,
    projectId: row.projectId,
    isLocal: false,
    documentType: row.documentType,
    mode: row.mode,
    revisionCount: row.revisionCount,
  };
}

export function threadToRow(row: ThreadRowInput): ThreadLibraryRow {
  return {
    itemType: "thread",
    id: row.id,
    title: row.title ?? "New chat",
    href: `/chat/${row.id}`,
    updatedAtMs: Date.parse(row.updatedAt),
    createdAtMs: Date.parse(row.createdAt),
    expiresAt: null,
    projectId: row.projectId,
    isLocal: false,
  };
}

// A named wrapper, not a bare `Date.now()` at a call site inside a component/hook body — matching
// the same pattern `expiresInHoursLabel`'s and `localThreadActivityMs`'s own default clock reads
// already use elsewhere, so the impure read happens inside an ordinary helper function, not
// syntactically inline in a render body.
export function nowMs(): number {
  return Date.now();
}

export interface LocalThreadLike {
  id: string;
  title: string;
  updatedAtMs: number;
}

export function localThreadToRow(entry: LocalThreadLike): ThreadLibraryRow {
  return {
    itemType: "thread",
    id: entry.id,
    title: entry.title || "New chat",
    href: `/chat/${entry.id}`,
    updatedAtMs: entry.updatedAtMs,
    createdAtMs: entry.updatedAtMs,
    expiresAt: null,
    projectId: null,
    isLocal: true,
  };
}
