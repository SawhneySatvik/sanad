"use client";

/**
 * The stretched-link pattern. The title is a real, visible <a> whose
 * own ::after covers the whole card (`absolute inset-0`), so the card is one genuine link, not a
 * <div onClick>. `group/menu-item` and the one `relative` positioning context both live on Card
 * itself — ItemMenu's own trigger (SidebarMenuAction) is already `position: absolute`, offset
 * against whichever ancestor is positioned, so a *second* `relative` on its own wrapper here would
 * make that zero-size wrapper the offset parent instead of the card, misplacing it entirely. Coming
 * later in Card's own DOM order than the anchor's `::after` is what keeps ItemMenu's trigger
 * paintable above the stretched link with no explicit z-index needed (same auto stacking level,
 * later tree order wins) — its menu portals out through Radix regardless.
 */

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { ItemMenu } from "@/components/shell/item-menu";
import { relativeTimeLabel } from "@/components/library/relative-time";
import { projectIcon } from "./project-icons";

export interface ProjectCardProps {
  id: string;
  name: string;
  icon: string | null;
  updatedAtMs: number;
  onRename(): void;
  onDelete(): void;
}

export function ProjectCard({ id, name, icon, updatedAtMs, onRename, onDelete }: ProjectCardProps) {
  // A fixed lucide glyph, never stateful — remounting it on an icon change has no observable
  // effect, unlike the stateful-component case this lint rule guards against.
  const Icon = projectIcon(icon);
  const updated = relativeTimeLabel(updatedAtMs);

  return (
    // ItemMenu itself hardcodes showOnHover with no override prop (shared shell chrome, not this
    // file to change) — the descendant override below forces its trigger to opacity-100 regardless
    // of hover/focus, since a (0,2,0) selector beats the (0,1,0) md:opacity-0 utility it ships with.
    <Card className="group/menu-item relative [&_[data-sidebar=menu-action]]:opacity-100">
      <CardContent className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-foreground">
          {/* eslint-disable-next-line react-hooks/static-components -- see the comment above Icon's assignment */}
          <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={`/projects/${id}`}
            className="font-display text-base font-medium text-foreground after:absolute after:inset-0"
            aria-label={`${name}, Updated ${updated}`}
          >
            {name}
          </Link>
          <span className="text-xs text-muted-foreground">Updated {updated}</span>
        </div>
      </CardContent>
      <div className="flex justify-end">
        <ItemMenu itemId={id} itemType="project" label={name} onRename={onRename} onDelete={onDelete} />
      </div>
    </Card>
  );
}
