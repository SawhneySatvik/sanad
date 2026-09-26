"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The client-side cap: every rename is 120 characters everywhere it's reachable through this
// dialog — project rename keeps the contract's own 255 server-side, but this dialog's own cap
// stays 120 for every itemType, matching the tighter client convention.
const MAX_TITLE_LENGTH = 120;

export interface RenameDialogProps {
  open: boolean;
  itemType: string;
  currentTitle: string;
  onSave: (title: string) => void;
  onCancel: () => void;
  submitting?: boolean;
}

/** Renders as a centred Dialog at both viewports — never a BottomSheet. */
export function RenameDialog({ open, itemType, currentTitle, onSave, onCancel, submitting }: RenameDialogProps) {
  const [title, setTitle] = useState(currentTitle);
  const fieldId = useId();
  const trimmed = title.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_TITLE_LENGTH;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {itemType}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onSave(trimmed);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId}>Name</Label>
            <Input
              id={fieldId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={MAX_TITLE_LENGTH + 20}
              autoFocus
              aria-invalid={!valid}
            />
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
