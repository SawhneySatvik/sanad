"use client";

/**
 * The guided-brief Textarea, shared between create mode (/drafts/new) and revise mode
 * (/drafts/[id]) — same 4000-character cap and counter either way. No `maxLength` attribute: the
 * screen's own choice is a disabled submit past the cap, never silent truncation, matching the
 * server's own min(1).max(4000) exactly.
 */

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "cn";
import { CHARACTER_LIMIT_NOTE, INSTRUCTIONS_MAX_LENGTH } from "./copy";

export interface InstructionsFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function InstructionsField({ label, value, onChange, placeholder, disabled }: InstructionsFieldProps) {
  const fieldId = useId();
  const counterId = useId();
  const overLimit = value.length > INSTRUCTIONS_MAX_LENGTH;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <Textarea
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={6}
        aria-describedby={counterId}
        aria-invalid={overLimit}
      />
      {/* Plain text, no aria-live: a per-keystroke live announcement here would spam the polite
          region far more than a user typing needs. */}
      <p id={counterId} className={cn("text-xs text-muted-foreground", overLimit && "text-destructive")}>
        {value.length} / {INSTRUCTIONS_MAX_LENGTH} — {CHARACTER_LIMIT_NOTE}
      </p>
    </div>
  );
}
