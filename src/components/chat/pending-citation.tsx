"use client";

/**
 * A reopened local thread's citation before (or after a failed) re-verify — deliberately never
 * composes VerificationBadge/CitationChip: a citation must start with NO badge at all, never
 * a stale one that later "resolves" into a different badge. This is the pending renderer's whole
 * reason to exist as its own component rather than a CitationChip variant.
 */

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";

export interface PendingCitationChipProps {
  preview: string;
  failed?: boolean;
  onRetry?: () => void;
}

// Keeps a 44x44px touch hit area even though the visible control stays a small icon-only button —
// matches CitationChip's own info button (src/components/verification/citation-chip.tsx): a
// pseudo-element grown from an unsized button would land short of the floor, so the button's own
// box is sized to 24px (icon-xs) first, then a 10px inset on each side reaches 44px exactly.
const TOUCH_HIT_AREA = "relative before:absolute before:-inset-2.5 before:content-['']";

export function PendingCitationChip({ preview, failed, onRetry }: PendingCitationChipProps) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-dashed border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      <span className="max-w-64 truncate">
        <bdi style={BIDI_ISOLATE_STYLE}>{preview}</bdi>
      </span>
      <span>{failed ? "Couldn't re-check right now" : "Checking…"}</span>
      {failed && onRetry && (
        <Button type="button" variant="ghost" size="icon-xs" onClick={onRetry} aria-label="Retry re-checking this citation" className={TOUCH_HIT_AREA}>
          <RefreshCw aria-hidden="true" className="size-3" strokeWidth={1.75} />
        </Button>
      )}
    </span>
  );
}
