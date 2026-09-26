"use client";

import { useId, useRef } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmDeleteItemType = "document" | "comparison" | "draft" | "thread" | "project" | "all_data";

export interface DeleteImpact {
  comparisons: number;
  draftsUngrounded: number;
  threadsUnlinked: number;
}

export interface ConfirmDeleteDialogProps {
  open: boolean;
  variant?: "delete" | "unassign";
  itemType: ConfirmDeleteItemType;
  itemTitle?: string;
  /** A draft states "All N revisions" from its own count, never a generic count. */
  revisionCount?: number;
  /** Only `itemType: "document"` gets impact, from GET /api/documents/:id/delete-impact. */
  impact?: DeleteImpact;
  /** Overrides the computed description — Settings' own guest/user Data-section paragraph, for
   * example, states the scope more precisely than a generic default could. */
  description?: string;
  onConfirm: () => void;
  onCancel: () => void;
  submitting?: boolean;
}

const NOUN_BY_TYPE: Record<ConfirmDeleteItemType, string> = {
  document: "document",
  comparison: "comparison",
  draft: "draft",
  thread: "chat",
  project: "project",
  all_data: "data",
};

function defaultDescription(props: ConfirmDeleteDialogProps): string {
  const { itemType, variant = "delete", revisionCount, impact, itemTitle } = props;
  const named = itemTitle ? `"${itemTitle}"` : `this ${NOUN_BY_TYPE[itemType]}`;

  if (variant === "unassign") return `${named} will be removed from this project. It is not deleted.`;

  if (itemType === "draft") {
    const count = revisionCount ?? 1;
    return `All ${count} revision${count === 1 ? "" : "s"} of ${named} will be permanently deleted.`;
  }
  if (itemType === "document") {
    const parts: string[] = [`${named} will be permanently deleted.`];
    if (impact && (impact.comparisons > 0 || impact.draftsUngrounded > 0 || impact.threadsUnlinked > 0)) {
      parts.push(
        `This affects ${impact.comparisons} comparison(s), ${impact.draftsUngrounded} draft(s) and ${impact.threadsUnlinked} chat(s).`,
      );
    }
    parts.push("Chats on this device that quote it will show it as unavailable.");
    return parts.join(" ");
  }
  if (itemType === "all_data") return "This will permanently delete your data. This cannot be undone.";
  return `${named} will be permanently deleted.`;
}

function confirmLabel(itemType: ConfirmDeleteItemType, variant: "delete" | "unassign"): string {
  if (itemType === "all_data") return "Delete all my data";
  return variant === "unassign" ? "Remove" : "Delete";
}

/**
 * States exactly what a delete (or unassign) removes. Radix AlertDialog auto-focuses its first
 * focusable descendant by default; `onOpenAutoFocus` redirects that to Cancel explicitly, never the
 * destructive confirm button, so an accidental Enter press on open can't confirm anything.
 */
export function ConfirmDeleteDialog(props: ConfirmDeleteDialogProps) {
  const { open, variant = "delete", itemType, onConfirm, onCancel, submitting } = props;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const description = props.description ?? defaultDescription(props);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent onOpenAutoFocus={(event) => {
        event.preventDefault();
        cancelRef.current?.focus();
      }} aria-describedby={descriptionId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{variant === "unassign" ? "Remove from project" : "Delete this?"}</AlertDialogTitle>
          <AlertDialogDescription id={descriptionId}>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* No explicit onClick here: AlertDialogPrimitive.Cancel's own close already fires
              onOpenChange(false) above, which calls onCancel — a second explicit call here would
              double-fire it. */}
          <AlertDialogCancel ref={cancelRef}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={variant === "delete" ? "destructive" : "default"}
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {confirmLabel(itemType, variant)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
