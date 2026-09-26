"use client";

/**
 * The phone "Revisions (N)" sheet. Built directly on the existing Sheet primitive (Radix Dialog,
 * side="bottom") rather than importing a generic BottomSheet — no such shared component exists
 * outside the workspace surface's own (src/components/workspace/layout/bottom-sheet.tsx), so this is
 * a local, single-purpose copy of that same "Sheet side=bottom" construction: Radix already provides
 * the required aria-modal focus trap, Esc-to-close and backdrop-tap dismissal.
 */

import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export interface RevisionsBottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

export function RevisionsBottomSheet({ open, onOpenChange, title, children }: RevisionsBottomSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex max-h-[80dvh] flex-col rounded-t-xl border-t border-border p-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
