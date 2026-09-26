"use client";

import { Ellipsis } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuAction } from "@/components/ui/sidebar";

export interface ItemMenuProps {
  itemId: string;
  itemType: "document" | "comparison" | "draft" | "thread" | "project";
  /** A human label for the trigger's accessible name, e.g. a filename or thread title. */
  label: string;
  onRename: () => void;
  onDelete: () => void;
  onSaveToProject?: () => void;
}

/**
 * Hover/focus-revealed per-row actions. `showOnHover` (SidebarMenuAction's own prop) keeps the
 * trigger's layout space reserved at rest (`visibility: hidden`, never `display: none`) so Tab order
 * stays stable — never a `:hover`-only reveal that a keyboard user can't reach.
 */
export function ItemMenu({ itemId, itemType, label, onRename, onDelete, onSaveToProject }: ItemMenuProps) {
  return (
    // modal={false}: Radix's modal menu calls aria-hidden's hideOthers() on the rest of the page
    // while open, but never strips tabindex from what it hides — a focusable sidebar link or
    // button behind an open row menu is then aria-hidden and still reachable by Tab, an
    // aria-hidden-focus violation. A lightweight row action menu needs none of the modal's
    // scroll-lock/outside-hidden behaviour to begin with.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          showOnHover
          data-item-id={itemId}
          aria-label={`Actions for ${label}`}
          // Pads the tappable area to the 44x44 touch floor without growing the trigger's own
          // visual footprint — the visible glyph stays the icon's own small size.
          className="before:absolute before:-inset-3 before:content-['']"
        >
          <Ellipsis aria-hidden="true" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        {onSaveToProject && itemType !== "project" && (
          <DropdownMenuItem onSelect={onSaveToProject}>Save to project</DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
