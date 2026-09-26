"use client";

/**
 * ItemMenu (shell, imported not edited) plus this row's own "Save to project" panel — a guest gets
 * SignInNudge, a user gets the real ProjectPicker, both anchored to this same trigger via Radix
 * Popover's Anchor (not its Trigger, since ItemMenu owns the actual click that opens either panel,
 * and has no onSelect/event access of its own to coordinate this more tightly).
 */

import { useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { ItemMenu } from "@/components/shell/item-menu";
import { ProjectPicker } from "@/components/projects/project-picker";
import { SignInNudge } from "@/components/upload";
import type { LibraryRow } from "./library-row";

export interface SaveToProjectHandlers {
  isGuest: boolean;
  onSignIn(): void;
  onSelect(projectId: string): Promise<void>;
}

export interface LibraryRowActionsProps {
  row: LibraryRow;
  onRename(): void;
  onDelete(): void;
  /** Absent entirely when !signInAvailable — ItemMenu then never renders the "Save to project" entry. */
  saveToProject?: SaveToProjectHandlers;
}

export function LibraryRowActions({ row, onRename, onDelete, saveToProject }: LibraryRowActionsProps) {
  const [panel, setPanel] = useState<"none" | "nudge" | "picker">("none");

  const trigger = (
    // ItemMenu itself hardcodes showOnHover with no override prop (shared shell chrome, not this
    // file to change) — the descendant override below forces its trigger to opacity-100 regardless
    // of hover/focus, since a (0,2,0) selector beats the (0,1,0) md:opacity-0 utility it ships with.
    <div className="group/menu-item relative flex justify-end [&_[data-sidebar=menu-action]]:opacity-100">
      <ItemMenu
        itemId={row.id}
        itemType={row.itemType}
        label={row.title}
        onRename={onRename}
        onDelete={onDelete}
        onSaveToProject={
          saveToProject && !row.isLocal ? () => setPanel(saveToProject.isGuest ? "nudge" : "picker") : undefined
        }
      />
    </div>
  );

  if (panel === "picker" && saveToProject) {
    return (
      <ProjectPicker
        open
        onOpenChange={(open) => !open && setPanel("none")}
        anchor={trigger}
        onSelect={async (projectId) => {
          await saveToProject.onSelect(projectId);
          setPanel("none");
        }}
      />
    );
  }

  if (panel === "nudge" && saveToProject) {
    return (
      <Popover open onOpenChange={(open) => !open && setPanel("none")}>
        <PopoverAnchor asChild>{trigger}</PopoverAnchor>
        <PopoverContent align="end" className="w-72">
          <SignInNudge context="save" onSignIn={saveToProject.onSignIn} />
        </PopoverContent>
      </Popover>
    );
  }

  return trigger;
}
