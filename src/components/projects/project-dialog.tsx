"use client";

/**
 * Create or rename a project. The name field never gets `maxLength` truncation — a project renamed
 * some other way to well over 120 characters must still render its full existing name so the
 * counter/validation can visibly reject it, which a hard `maxLength` on the input would silently
 * prevent instead.
 */

import { useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PROJECT_ICON_LABELS, PROJECT_ICON_NAMES, projectIcon, type ProjectIconName } from "./project-icons";

const NAME_MAX = 120;

export interface ProjectDialogSaveInput {
  name: string;
  icon?: string;
}

export interface ProjectDialogProps {
  open: boolean;
  mode: "create" | "rename";
  initialName?: string;
  initialIcon?: string | null;
  onSave(input: ProjectDialogSaveInput): void;
  onCancel(): void;
  submitting?: boolean;
}

/** Create or rename a project. Centred Dialog at both viewports on every screen size. */
export function ProjectDialog({ open, mode, initialName = "", initialIcon = null, onSave, onCancel, submitting }: ProjectDialogProps) {
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<string | null>(initialIcon);
  const fieldId = useId();
  const trimmed = name.trim();
  const empty = trimmed.length === 0;
  const overCap = trimmed.length > NAME_MAX;
  const valid = !empty && !overCap;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New project" : "Rename project"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onSave(mode === "create" ? { name: trimmed, icon: icon ?? undefined } : { name: trimmed });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId}>Name</Label>
            <Input id={fieldId} value={name} onChange={(event) => setName(event.target.value)} autoFocus aria-invalid={!valid} />
            {empty ? (
              <p className="text-xs text-destructive">Give it a name.</p>
            ) : overCap ? (
              <p className="text-xs text-destructive">{NAME_MAX} characters or fewer.</p>
            ) : (
              <p className="text-xs text-muted-foreground">{NAME_MAX} characters or fewer.</p>
            )}
          </div>

          {mode === "create" && (
            <div className="mt-4 flex flex-col gap-1.5">
              <span className="text-sm font-medium">Icon (optional)</span>
              {/* The radiogroup's own accessible name is the plain "Icon" — the visible label above
                  says "Icon (optional)" for sighted users, a distinct string on purpose, so
                  aria-label is set directly rather than aria-labelledby pointing at it. */}
              <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-2">
                {PROJECT_ICON_NAMES.map((name_) => {
                  const Icon = projectIcon(name_);
                  const selected = icon === name_;
                  return (
                    <button
                      key={name_}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={PROJECT_ICON_LABELS[name_ as ProjectIconName]}
                      onClick={() => setIcon(selected ? null : name_)}
                      className={`flex size-9 items-center justify-center rounded-full border ${selected ? "border-primary bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}
                    >
                      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              {mode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
