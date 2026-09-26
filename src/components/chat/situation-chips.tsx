"use client";

/** "I am a…" tenant/employee/freelancer/other — never a modal or gate, changeable anytime. */

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { SituationRole } from "./catalogue";

export interface SituationChipsProps {
  value: SituationRole | null;
  onChange: (value: SituationRole | null) => void;
}

const OPTIONS: { value: SituationRole; label: string }[] = [
  { value: "tenant", label: "I'm a tenant" },
  { value: "employee", label: "I'm an employee" },
  { value: "freelancer", label: "I'm a freelancer" },
  { value: "other", label: "Something else" },
];

/**
 * A labelled group of toggle buttons — never a native radio input. Radix's own `type="single"`
 * ToggleGroup renders `role="radiogroup"`/`role="radio"` (confirmed against the rendered a11y
 * tree, not assumed), which is exactly the radio semantics this group must avoid; `type="multiple"`
 * renders plain `role="group"` + button items with `aria-pressed`, so the single-select constraint
 * (at most one chip active) is enforced here instead of by Radix's own exclusivity logic.
 */
export function SituationChips({ value, onChange }: SituationChipsProps) {
  return (
    <ToggleGroup
      type="multiple"
      variant="outline"
      aria-label="I am a…"
      value={value ? [value] : []}
      onValueChange={(next: string[]) => {
        if (next.length === 0) {
          onChange(null);
          return;
        }
        // Radix reports every currently-pressed item; the newly-pressed one (not the one this
        // group already had active) is the user's actual selection.
        const added = next.find((v) => v !== value) ?? next[0];
        onChange(added as SituationRole);
      }}
      className="flex flex-wrap justify-center gap-2"
    >
      {OPTIONS.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
