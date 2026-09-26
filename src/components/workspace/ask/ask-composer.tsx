"use client";

/**
 * The pinned Ask composer — a deliberately minimal, self-contained control scoped to this page's
 * own Ask panel, not a second copy of the /chat surface's own Composer (src/components/chat/**)
 * and its attach/upload affordances: this screen's own uploads are ignored on purpose, since every
 * upload lives in the chat composer instead.
 */

import { useRef } from "react";
import { Send } from "lucide-react";
import { DisclaimerLine } from "@/components/brand/disclaimer-line";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ASK_COMPOSER_PLACEHOLDER } from "../copy";

export interface AskComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (value: string) => void;
  disabled?: boolean;
  /** Disables sending alone (Enter and the button) while an answer is still streaming — the field itself stays typable, and focus, so the next turn can be composed without losing either. */
  sendDisabled?: boolean;
}

export function AskComposer({ value, onChange, onSend, disabled, sendDisabled }: AskComposerProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const blockSend = disabled || sendDisabled;

  function submit() {
    if (blockSend || !value.trim()) return;
    onSend(value);
    fieldRef.current?.focus();
  }

  return (
    <div className="border-t border-border bg-card [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">
      <form
        className="flex items-end gap-2 p-3 pb-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Textarea
          ref={fieldRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={ASK_COMPOSER_PLACEHOLDER}
          aria-label={ASK_COMPOSER_PLACEHOLDER}
          rows={1}
          disabled={disabled}
          className="min-h-[44px] flex-1 resize-none"
        />
        <Button type="submit" size="icon" className="size-11" aria-label="Send" disabled={blockSend || !value.trim()}>
          <Send aria-hidden="true" />
        </Button>
      </form>
      {/* The shell drops its footer copy on this route, so this is the screen's one disclaimer: the
          composer renders exactly once in both the desktop split and the phone layout. */}
      <div className="px-3 pb-1">
        <DisclaimerLine variant="composer" />
      </div>
    </div>
  );
}
