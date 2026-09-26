"use client";

/**
 * Prepare's own "Viewing as" control — not workspace's LensToggle, which has no disabled/
 * aria-describedby prop and belongs to another lane. A real Select at both viewports (same rule
 * LensToggle itself follows), but here a change is a genuinely new, chargeable model call rather
 * than a free client-side switch, so the lens-change note beside it is load-bearing, not decorative.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { lensLabel } from "@/shared/lens-labels";
import type { LensOption } from "@/components/workspace/lens/resolve-default-lens";
import { LENS_CHANGE_NOTE, VIEWING_AS_LABEL } from "./copy";

export interface PrepareLensSelectProps {
  options: readonly LensOption[];
  value: string;
  onChange: (lens: string) => void;
  disabled?: boolean;
}

export function PrepareLensSelect({ options, value, onChange, disabled }: PrepareLensSelectProps) {
  const noteId = "prepare-lens-change-note";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{VIEWING_AS_LABEL}</span>
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger aria-label={VIEWING_AS_LABEL} aria-describedby={noteId} className="min-h-11 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {lensLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p id={noteId} className="text-xs text-muted-foreground">
        {LENS_CHANGE_NOTE}
      </p>
    </div>
  );
}
