"use client";

/**
 * /projects/[id]'s own row menu: Rename and "Remove from project" — the shell's ItemMenu
 * (src/components/shell/item-menu.tsx) has no way to relabel its "Save to project" entry or swap its
 * handler for this screen's own action, so this is a structural near-copy of it (an optional
 * `saveToProjectLabel`/`onRemoveFromProject` slot on ItemMenu itself would remove the duplication,
 * but ItemMenu is shared chrome used elsewhere, not this component's own file to change).
 *
 * Deliberately no "Delete" entry here: no destructive-delete copy or behaviour is defined for a row
 * on this route (only "Remove from project," which is never destructive) — resolved conservatively,
 * with no unstated copy invented for an irreversible action that would also need to explain deleting
 * a whole revision chain from a possibly-partial project view.
 */

import { Ellipsis } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarMenuAction } from "@/components/ui/sidebar";

export interface ProjectItemMenuProps {
  itemId: string;
  label: string;
  onRename(): void;
  onRemoveFromProject(): void;
}

export function ProjectItemMenu({ itemId, label, onRename, onRemoveFromProject }: ProjectItemMenuProps) {
  return (
    // Non-modal, as ItemMenu: a modal Radix menu aria-hides the page behind it without taking its
    // controls out of the Tab order.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* No showOnHover: a hover-revealed trigger has no reveal gesture at all on a touch
            device, so every row's own actions stay visible at rest instead. */}
        <SidebarMenuAction
          data-item-id={itemId}
          aria-label={`Actions for ${label}`}
          className="before:absolute before:-inset-3 before:content-['']"
        >
          <Ellipsis aria-hidden="true" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={onRemoveFromProject}>Remove from project</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
