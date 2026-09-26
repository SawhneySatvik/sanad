"use client";

/**
 * The grounded branch's own document picker: a plain Select, not a phone sheet or the fuller,
 * shared project/document picker the library/projects surface owns
 * (src/components/{library,projects}/**) — this field's own list is short enough that pulling in
 * that heavier component would be overkill, the same call save-to-project-dialog.tsx makes for an
 * identical gap.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COULD_NOT_BE_READ_NOTE, STILL_PROCESSING_NOTE } from "./copy";

export interface GroundingOption {
  id: string;
  title: string;
  processingStatus: "pending" | "ready" | "extraction_failed";
}

export interface GroundingDocumentPickerProps {
  /** Pairs with the caller's own <Label htmlFor> — this component owns no visible label of its own. */
  id: string;
  options: GroundingOption[];
  value: string | null;
  onChange: (documentId: string) => void;
  loading?: boolean;
  disabled?: boolean;
}

function statusNote(status: GroundingOption["processingStatus"]): string | null {
  if (status === "pending") return STILL_PROCESSING_NOTE;
  if (status === "extraction_failed") return COULD_NOT_BE_READ_NOTE;
  return null;
}

export function optionLabel(option: GroundingOption): string {
  const note = statusNote(option.processingStatus);
  return note ? `${option.title} — ${note}` : option.title;
}

export function GroundingDocumentPicker({ id, options, value, onChange, loading, disabled }: GroundingDocumentPickerProps) {
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled || options.length === 0}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={loading ? "Loading your documents…" : "Choose a document"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {optionLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
