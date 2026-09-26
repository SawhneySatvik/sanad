"use client";

/**
 * /projects/[id]'s per-section rows: a thin wrapper reusing LibraryTable's underlying <table> markup
 * and column conventions, scoped to one section, rather than a visually different list style. Every
 * summary type here already carries its own resolved `title` — no per-row title-fetch. On phone this
 * drops the table for a plain <ul> instead, the same convention library-table.tsx uses, driven by a
 * real media-query hook (useIsMobile), not a CSS-only hide.
 */

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { ProjectItemMenu } from "./project-item-menu";

export interface ProjectSectionRow {
  id: string;
  title: string;
  secondary?: string;
  href: string;
}

export interface ProjectSectionTableProps {
  rows: ProjectSectionRow[];
  onRename(row: ProjectSectionRow): void;
  onRemoveFromProject(row: ProjectSectionRow): void;
}

export function ProjectSectionTable({ rows, onRename, onRemoveFromProject }: ProjectSectionTableProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="flex min-h-11 items-center justify-between gap-2 py-2">
            <div className="min-w-0 flex-1">
              <Link href={row.href} className="block truncate font-medium text-foreground hover:underline">
                {row.title}
              </Link>
              {row.secondary && <div className="mt-0.5 truncate text-xs text-muted-foreground">{row.secondary}</div>}
            </div>
            {/* A real 44px box, not a bare flex item: SidebarMenuAction positions itself
                absolutely, so a zero-size flex sibling gives it nothing to anchor against and it
                ends up overlapping the truncated title next to it instead of sitting in its own
                spot. */}
            <div className="group/menu-item relative size-11 shrink-0">
              <ProjectItemMenu itemId={row.id} label={row.title} onRename={() => onRename(row)} onRemoveFromProject={() => onRemoveFromProject(row)} />
            </div>
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
          <TableHead scope="col" className="text-right">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className="h-11">
            <TableCell>
              <Link href={row.href} className="font-medium text-foreground hover:underline">
                {row.title}
              </Link>
              {row.secondary && <div className="mt-0.5 text-xs text-muted-foreground">{row.secondary}</div>}
            </TableCell>
            <TableCell className="text-right">
              <div className="group/menu-item relative flex justify-end">
                <ProjectItemMenu
                  itemId={row.id}
                  label={row.title}
                  onRename={() => onRename(row)}
                  onRemoveFromProject={() => onRemoveFromProject(row)}
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
