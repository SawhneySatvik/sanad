"use client";

/**
 * A real <table> (shadcn Table) on desktop; on phone this drops the header row entirely for a
 * plain <ul> instead — a phone screen reads a table's own column headers no more usefully than a
 * list's, so it gets a real list, not a table with most of its cells hidden by CSS. Driven by a
 * real media-query hook (useIsMobile), the same convention project-section-table.tsx uses.
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ScanText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { expiresInHoursLabel } from "@/components/shell/recent-items";
import { documentTypeLabel, draftModeLabel } from "@/lib/copy/document-type-labels";
import { LibraryRowActions } from "./library-row-actions";
import { relativeTimeLabel } from "./relative-time";
import type { LibraryRow } from "./library-row";

export type LibraryTab = "all" | "document" | "comparison" | "draft" | "thread";

export interface LibraryTableProps {
  tab: LibraryTab;
  rows: LibraryRow[];
  onRename(row: LibraryRow): void;
  onDelete(row: LibraryRow): void;
  /** Absent entirely when !signInAvailable — ItemMenu then never renders the "Save to project" entry at all. */
  signInAvailable: boolean;
  isGuest: boolean;
  onSignIn(): void;
  onSaveToProject(row: LibraryRow, projectId: string): Promise<void>;
}

function typeColumnLabel(row: LibraryRow): string {
  if (row.itemType === "document") return documentTypeLabel(row.documentType);
  if (row.itemType === "comparison") return "Comparison";
  if (row.itemType === "draft") return "Draft";
  return "Chat";
}

function analysisPill(row: Extract<LibraryRow, { itemType: "document" }>) {
  if (row.processingStatus === "extraction_failed") return <Badge variant="outline">Couldn&apos;t be read</Badge>;
  if (row.analysisState === "not_analyzed") return <Badge variant="outline">Not analysed</Badge>;
  return <Badge variant="outline">{documentTypeLabel(row.documentType)}</Badge>;
}

function secondaryLine(row: LibraryRow): string | null {
  if (row.itemType === "draft") {
    return `${row.revisionCount} ${row.revisionCount === 1 ? "revision" : "revisions"}`;
  }
  if (row.itemType === "thread" && row.isLocal) return "This device only";
  return null;
}

/** The real expiry value, never the bare word "expires" — shared by the desktop Expires column and
 * the phone meta line, so the two can never show a different answer for the same row. */
function expiresLabel(row: LibraryRow): string | null {
  if (row.itemType === "thread" && row.isLocal) return "This device only";
  if (row.expiresAt) return expiresInHoursLabel(row.expiresAt);
  return null;
}

function expiresCell(row: LibraryRow) {
  const label = expiresLabel(row);
  return label ? <span className="text-xs text-muted-foreground">{label}</span> : null;
}

const relativeUpdated = relativeTimeLabel;

function metaLine(row: LibraryRow, showExtraColumn: boolean): string {
  const secondary = secondaryLine(row);
  const expires = expiresLabel(row);
  // A local thread's own expiresLabel repeats its secondaryLine verbatim ("This device only") —
  // never joined twice for the one row shape where both happen to resolve to the identical string.
  const mobileExpiry = expires && expires !== secondary ? expires : null;
  const parts = [relativeUpdated(row.updatedAtMs), secondary, mobileExpiry].filter((part): part is string => Boolean(part));
  const base = parts.join(" · ");
  return showExtraColumn && !secondary ? `${base} · ${typeColumnLabel(row)}` : base;
}

function AnalysisCell({ row }: { row: Extract<LibraryRow, { itemType: "document" }> }) {
  return (
    <div className="flex items-center gap-1.5">
      {analysisPill(row)}
      {row.inputMode === "native_document" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} aria-label="Read from an image" className="inline-flex text-muted-foreground">
              <ScanText aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </span>
          </TooltipTrigger>
          <TooltipContent>Read from an image</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function LibraryTable({ tab, rows, onRename, onDelete, signInAvailable, isGuest, onSignIn, onSaveToProject }: LibraryTableProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const showTypeColumn = tab === "all";
  const showAnalysisColumn = tab === "document";
  const showKindColumn = tab === "draft";
  const showExtraColumn = showTypeColumn || showAnalysisColumn || showKindColumn;

  function actionsFor(row: LibraryRow) {
    return (
      <LibraryRowActions
        row={row}
        onRename={() => onRename(row)}
        onDelete={() => onDelete(row)}
        saveToProject={signInAvailable ? { isGuest, onSignIn, onSelect: (projectId) => onSaveToProject(row, projectId) } : undefined}
      />
    );
  }

  if (isMobile) {
    return (
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li key={`${row.itemType}-${row.id}`} className="flex min-h-11 items-center justify-between gap-2 py-2">
            <div className="min-w-0 flex-1">
              <Link href={row.href} className="block truncate font-medium text-foreground hover:underline">
                {row.title}
              </Link>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{metaLine(row, showExtraColumn)}</div>
              {showAnalysisColumn && row.itemType === "document" && <AnalysisCell row={row} />}
            </div>
            {/* A real 44px box, not a bare flex item: SidebarMenuAction positions itself
                absolutely, so a zero-size flex sibling gives it nothing to anchor against and it
                ends up overlapping the truncated title next to it instead of sitting in its own
                spot. */}
            <div className="relative size-11 shrink-0">{actionsFor(row)}</div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Name</TableHead>
          {showTypeColumn && <TableHead scope="col">Type</TableHead>}
          {showAnalysisColumn && <TableHead scope="col">Analysis</TableHead>}
          {showKindColumn && <TableHead scope="col">Kind</TableHead>}
          <TableHead scope="col">Updated</TableHead>
          <TableHead scope="col">Expires</TableHead>
          <TableHead scope="col" className="text-right">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.itemType}-${row.id}`} className="h-11 cursor-pointer" onClick={() => router.push(row.href)}>
            <TableCell>
              <Link href={row.href} className="font-medium text-foreground hover:underline" onClick={(event) => event.stopPropagation()}>
                {row.title}
              </Link>
            </TableCell>
            {showTypeColumn && <TableCell className="text-muted-foreground">{typeColumnLabel(row)}</TableCell>}
            {showAnalysisColumn && row.itemType === "document" && (
              <TableCell>
                <AnalysisCell row={row} />
              </TableCell>
            )}
            {showKindColumn && row.itemType === "draft" && <TableCell className="text-muted-foreground">{draftModeLabel(row.mode)}</TableCell>}
            <TableCell className="tabular-nums text-muted-foreground">{relativeUpdated(row.updatedAtMs)}</TableCell>
            <TableCell>{expiresCell(row)}</TableCell>
            <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
              {actionsFor(row)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
