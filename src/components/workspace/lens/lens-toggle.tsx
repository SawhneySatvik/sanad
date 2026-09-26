"use client";

/**
 * "Viewing as" switcher — a Select at both viewports: the longest real labels, e.g. the lease
 * document's four lenses, don't fit a single-row ToggleGroup at 390px without scroll or truncation.
 * Options come from this document's own lensExplanations, never the server registry.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { lensLabel } from "@/shared/lens-labels";
import type { LensOption } from "./resolve-default-lens";
import { VIEWING_AS_LABEL } from "../copy";

export interface LensToggleProps {
  options: readonly LensOption[];
  value: string;
  onChange: (lens: string) => void;
}

export function LensToggle({ options, value, onChange }: LensToggleProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{VIEWING_AS_LABEL}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={VIEWING_AS_LABEL} className="max-w-full">
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
  );
}
