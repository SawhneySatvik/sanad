"use client";

import { Info } from "lucide-react";
import { cn } from "cn";
import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import { VerificationBadge } from "./verification-badge";

export interface CitationChipProps {
  citation: AskCitationOutput;
  /** AskCitationOutput carries no filename/title of its own — the host names the source document. */
  documentLabel: string;
  onActivate?: () => void;
  onShowInfo?: () => void;
}

// The badge's info button is a sibling of the chip, never a descendant of it — a button nested
// inside a button is invalid HTML and unreachable by assistive tech as two separate controls.
// Both controls keep a 44x44px touch hit area even though their own visual size stays small: the
// pseudo-element grows the tappable area without growing the visible pill/icon. The info button's
// own box is sized to 24px first (size-6) so a 10px inset on each side reaches 44px exactly — a
// pseudo-element grown from an unsized, icon-only button would land short of the floor.
const TOUCH_HIT_AREA = "relative before:absolute before:-inset-2.5 before:content-['']";

/**
 * One inline citation inside an assistant message. Clicking jumps to and pulses the cited span in
 * DocumentViewer — the host resolves the citation's own document text, runs it through bindSpan(),
 * and only pulses when the result is non-null; this component never binds a span itself.
 *
 * The preview text is derived here from the citation's own verification, never accepted as a
 * separate prop: the displayed passage must always be the same text the server verified — spanText
 * for verified/approximate, claimedQuote for not_found — never an arbitrary string a host could
 * substitute for it.
 */
export function CitationChip({ citation, documentLabel, onActivate, onShowInfo }: CitationChipProps) {
  const { verification } = citation;
  const statusWord = verification.status === "verified" ? "verified" : verification.status === "approximate" ? "approximate" : "not found in your document";
  const preview = verification.status === "not_found" ? verification.claimedQuote : verification.spanText;

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onActivate}
        aria-label={`Jump to citation in ${documentLabel}, ${statusWord}`}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-muted",
          TOUCH_HIT_AREA,
        )}
      >
        <VerificationBadge verification={verification} />
        {/* Wraps up to two lines rather than a single ellipsised one — a citation's own quote is the
            reader's one clue which passage this points to; truncating it to a fragment defeats that
            more than an extra line of chip height costs. */}
        <span className="line-clamp-2 min-w-0 font-reading">
          <bdi style={BIDI_ISOLATE_STYLE}>{preview}</bdi>
        </span>
      </button>
      <button
        type="button"
        onClick={onShowInfo}
        aria-label="What this verification status means"
        className={cn("inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground", TOUCH_HIT_AREA)}
      >
        <Info aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      </button>
    </span>
  );
}
