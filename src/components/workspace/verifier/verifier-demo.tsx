"use client";

/**
 * "Test this quote" — the in-place verifier ("try to fool the verifier"). Renders inline in place
 * of a FindingCard's static QuoteBlock/badge while editing; the field accepts any typed text, not
 * only edits to the original quote. Every badge shown here is `useVerifyBatch`'s own server-derived
 * `lastChecked.result` — this component never constructs a VerificationOutput itself, and the badge
 * is only ever rendered paired with the exact text it was checked against (useVerifyBatch's own
 * guarantee, see that file's header).
 */

import { useEffect, useId } from "react";
import { VerificationBadge } from "@/components/verification/verification-badge";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { bindSpan } from "@/lib/verification/bindSpan";
import type { DocumentTextOutput } from "@/shared/contracts/document-text";
import { useVerifyBatch } from "./use-verify-batch";
import { VERIFIER_CHECKING_LABEL, VERIFIER_DONE_LABEL } from "../copy";

export interface VerifierDemoHighlight {
  spanStart: number;
  spanEnd: number;
  spanText: string;
  tone: "default" | "approximate";
}

export interface VerifierDemoProps {
  documentId: string;
  initialText: string;
  documentText: DocumentTextOutput | undefined;
  onHighlightChange: (highlight: VerifierDemoHighlight | null) => void;
  onDone: () => void;
  disabled?: boolean;
}

export function VerifierDemo({ documentId, initialText, documentText, onHighlightChange, onDone, disabled }: VerifierDemoProps) {
  const { text, setText, phase, lastChecked, errorMessage } = useVerifyBatch(documentId, initialText);
  const fieldId = useId();

  useEffect(() => {
    // Only a genuinely live "result" drives the document mark — an error phase still shows the
    // sticky badge (the field text was reverted to match it), but never re-lights the mark, keeping
    // this proof strictly tied to an in-the-moment check.
    if (phase !== "result" || !lastChecked || !documentText || lastChecked.result.status === "not_found") {
      onHighlightChange(null);
      return;
    }
    const bound = bindSpan(lastChecked.result, documentText, { documentId });
    onHighlightChange(bound ? { ...bound, tone: lastChecked.result.status === "approximate" ? "approximate" : "default" } : null);
    // Removed on every result change and on unmount alike — never persists past the edit session.
    return () => onHighlightChange(null);
  }, [phase, lastChecked, documentText, documentId, onHighlightChange]);

  const showBadge = lastChecked !== null && (phase === "result" || phase === "error");

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <Label htmlFor={fieldId}>Test this quote</Label>
      <Textarea
        id={fieldId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
        autoFocus
        rows={3}
        disabled={disabled}
        className="text-sm"
      />
      <div className="flex min-h-[1.5rem] flex-wrap items-center gap-2">
        {phase === "checking" && <span className="text-sm text-muted-foreground">{VERIFIER_CHECKING_LABEL}</span>}
        {showBadge && lastChecked && <VerificationBadge verification={lastChecked.result} />}
        {(phase === "error" || phase === "too-long" || phase === "throttled") && errorMessage && <p className="text-sm text-muted-foreground">{errorMessage}</p>}
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {VERIFIER_DONE_LABEL}
        </Button>
      </div>
    </div>
  );
}
