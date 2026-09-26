"use client";

/**
 * DraftComposer's revise mode for /drafts/[id] — kept as its own small component rather than
 * threading revise-only state through the create-mode DraftComposer, which owns several fields
 * (mode, type, grounding picker) revising never touches: everything is inherited server-side by
 * draft.ts's own revise().
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InstructionsField } from "./instructions-field";
import { INSTRUCTIONS_MAX_LENGTH, REVISE_ACTION_LABEL, REVISE_NOTICE } from "./copy";

export interface ReviseFormProps {
  onSubmit: (userInstructions: string) => void;
  submitting: boolean;
  offline: boolean;
}

export function ReviseForm({ onSubmit, submitting, offline }: ReviseFormProps) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && value.length <= INSTRUCTIONS_MAX_LENGTH && !offline && !submitting;

  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-4 print:hidden"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit(trimmed);
      }}
    >
      <p className="text-sm text-muted-foreground">{REVISE_NOTICE}</p>
      <fieldset disabled={submitting} className="flex flex-col gap-3">
        <legend className="sr-only">Revise this draft</legend>
        <InstructionsField label="Revise this draft" value={value} onChange={setValue} />
        <Button type="submit" disabled={!canSubmit} aria-disabled={!canSubmit} className="sm:w-fit">
          {submitting ? "Revising…" : REVISE_ACTION_LABEL}
        </Button>
      </fieldset>
    </form>
  );
}
