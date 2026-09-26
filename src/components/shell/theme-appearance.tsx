"use client";

/**
 * Settings' own inline theme control — a three-option RadioGroup, distinct from the sidebar's
 * compact ThemeToggle dropdown: not a dropdown here, since a standalone row of options reads more
 * clearly on a settings page. Both surfaces drive the same next-themes storage key, so either one
 * changing the theme is immediately reflected by the other.
 */

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

const subscribeNever = () => () => {};

// Mirrors ThemeToggle's own mounted gate: next-themes only knows the resolved theme after
// hydration, so rendering its value before that would mismatch the server-rendered markup.
function useMounted(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

export function ThemeAppearance() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <RadioGroup
      aria-label="Appearance"
      value={mounted ? theme : undefined}
      onValueChange={setTheme}
      className="grid-cols-1 sm:grid-cols-3"
    >
      {OPTIONS.map(({ value, label }) => (
        <Label key={value} className="flex items-center gap-2 rounded-lg border border-border p-3 has-data-checked:border-primary">
          <RadioGroupItem value={value} />
          {label}
        </Label>
      ))}
    </RadioGroup>
  );
}
