"use client";

/**
 * The phone Findings/Ask sheet. Built on the existing Sheet primitive (Radix Dialog,
 * side="bottom") rather than a from-scratch Dialog+motion build: it already gives the
 * required aria-modal focus trap, Esc-to-close and backdrop-tap dismissal, which is every non-drag
 * dismissal path this sheet needs — drag-to-dismiss is an enhancement not implemented here, never
 * the only way out of the sheet.
 *
 * `onCloseAutoFocus` is the caller's own to override, not prevented here unconditionally: Radix's
 * default (return focus to the sheet's own trigger) is exactly right for an ordinary Esc/backdrop
 * close, and only wrong for the one case a caller knows about — a pending "jump to a mark" that
 * needs to run instead, once the exit animation (and the aria-hidden it holds on the rest of the
 * page while open) has actually finished. A blanket preventDefault here would break the ordinary
 * case for every other close.
 */

import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export interface WorkspaceBottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
}

export function WorkspaceBottomSheet({ open, onOpenChange, title, children, onCloseAutoFocus }: WorkspaceBottomSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex h-[92dvh] max-h-[92dvh] flex-col rounded-t-xl border-t border-border p-0 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-none"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
