"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type FocusEvent } from "react";
import { useAnnounce } from "@/components/layout-primitives/live-region";
import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";
import type { Segment } from "@/lib/verification/segmentDocumentText";
import { Button } from "@/components/ui/button";
import { HighlightMark } from "./highlight-mark";
import { ScannedNotice } from "./scanned-notice";

// The one string every null-bind case announces — this component's own, and the identical string a
// Compare-style two-pane host falls back to as well, so it lives here once rather than being
// duplicated per host.
export const SPAN_NOT_LOCATED_ANNOUNCEMENT = "This quote couldn't be located in the document text.";

// The pulse is a one-shot ring flash on the mark a jump just landed on, layered on top of the
// lasting "this is selected" wash `current` already carries (HighlightMark) — the ring appears for
// this window and then reverts, leaving the wash in place. Reduced motion still needs the discrete
// change to be visible for a moment, hence the longer hold.
const PULSE_HOLD_MS = 480;
const PULSE_HOLD_MS_REDUCED_MOTION = 1200;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface DocumentViewerJump {
  findingId: string;
  /** Disambiguates a repeat activation of the same finding — a plain findingId can't tell "clicked
   * again" apart from "nothing changed," so the effect that moves focus keys off this, not the id. */
  seq: number;
  /** The host's own found-case announcement ("Showing this obligation in the document." /
   * "Showing this change in Document A.") — DocumentViewer has no category/side text of its own,
   * only segments, so it cannot build this string itself; the null-bind string above is the one it
   * always owns regardless of host. */
  announcement: string;
  /** Where Esc / the "Back to finding" control returns focus — capturing document.activeElement at
   * jump time is not reliable (a click does not always focus its own button), so the host hands
   * over the exact element instead. */
  returnFocusTo: HTMLElement | null;
}

export interface DocumentViewerProps {
  documentId: string;
  segments: Segment[];
  inputMode: "text" | "native_document";
  /** The currently-selected finding, if any — drives HighlightMark's persistent `current` wash (so
   * the reader's pick keeps standing out after a jump's own one-shot `active` pulse has faded), and
   * is also exposed as a `data-` attribute on its mark for a host or a test to key off. */
  activeFindingId?: string | null;
  label?: string;
  backLabel?: string;
  jump?: DocumentViewerJump | null;
}

function segmentKey(segment: Segment): string {
  return `${segment.start}-${segment.end}`;
}

/**
 * Renders a document's text with highlights. Receives only segmentDocumentText()'s output, built
 * from the host's own bindSpan() calls — never a raw FindingOutput/VerificationOutput and the
 * document's text together, and never binds a span itself: one binding site, full stop. Plain text
 * nodes only, never HTML or Markdown; no <mark> renders where a segment's tone is null.
 */
export function DocumentViewer({ documentId, segments, inputMode, activeFindingId = null, label, backLabel, jump = null }: DocumentViewerProps) {
  const announce = useAnnounce();
  const containerRef = useRef<HTMLElement>(null);
  const markRefs = useRef(new Map<string, HTMLElement>());
  const announcedSeq = useRef<number | null>(null);

  // A history of every finding id that has ever been a jump target, so its mark keeps tabindex=-1
  // even after a later, different jump lands elsewhere.
  const [everJumpedIds, setEverJumpedIds] = useState<ReadonlySet<string>>(new Set());
  const [lastRenderedSeq, setLastRenderedSeq] = useState<number | null>(null);
  // Every segment key currently mid-pulse, or null once the hold has elapsed — see PULSE_HOLD_MS
  // above. A single jump can span more than one rendered segment (an overlap with another finding
  // splits its own quote into several bdi/mark pieces), and every one of them pulses together, not
  // just the first — a partial pulse would visually clip the quote at the overlap boundary.
  const [pulsingKeys, setPulsingKeys] = useState<ReadonlySet<string> | null>(null);
  // The seq a blur-out-of-the-pane most recently dismissed the "Back to finding" control for. A new
  // jump carries a new seq, so the control reappears for it automatically, with no reset needed.
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);

  // Every rendered segment that belongs to the jumped-to finding, in document order — one when the
  // quote stands alone, several when another finding's range overlaps part of it (segmentDocumentText
  // cuts a fresh boundary at every finding's edge, so one finding's own quote can come back as more
  // than one Segment). All of them are "the whole quote"; only the first is a real focus target.
  const currentJumpSegments = useMemo(() => {
    if (!jump) return [];
    return segments.filter((s) => s.findingIds.includes(jump.findingId));
  }, [jump, segments]);
  const currentJumpSegment = currentJumpSegments[0] ?? null;
  const lastJumpSegment = currentJumpSegments[currentJumpSegments.length - 1] ?? null;

  // Adjusting state during render (React's own sanctioned alternative to an effect for this) —
  // guarded by comparing this render's seq against the last one recorded, so it fires at most once
  // per activation. This is what makes a mark's tabindex=-1 durable in the SAME commit its jump
  // lands, rather than one render behind an effect-driven update; it also starts the pulse
  // synchronously with the jump landing, instead of one paint later.
  if (jump && jump.seq !== lastRenderedSeq) {
    setLastRenderedSeq(jump.seq);
    if (currentJumpSegments.length > 0) {
      const { findingId } = jump;
      setEverJumpedIds((prev) => (prev.has(findingId) ? prev : new Set(prev).add(findingId)));
      setPulsingKeys(new Set(currentJumpSegments.map(segmentKey)));
    } else {
      setPulsingKeys(null);
    }
  }

  // The pulse's own hold-then-revert timer — deferred inside the timeout callback, never called
  // synchronously in the effect body, so a later jump's own render-phase update above is never
  // fought by a stale timer from an earlier one.
  useEffect(() => {
    if (pulsingKeys === null) return;
    const timeout = setTimeout(() => setPulsingKeys((current) => (current === pulsingKeys ? null : current)), prefersReducedMotion() ? PULSE_HOLD_MS_REDUCED_MOTION : PULSE_HOLD_MS);
    return () => clearTimeout(timeout);
  }, [pulsingKeys]);

  // The only two things this jump mechanism ever does imperatively: move real DOM focus, and push
  // one polite announcement. Everything else about "which segment" is already derived above. Focus
  // always lands on the FIRST constituent segment — the start of the quote — even when the quote
  // itself spans several marks.
  useEffect(() => {
    if (!jump || announcedSeq.current === jump.seq) return;
    announcedSeq.current = jump.seq;
    if (!currentJumpSegment) {
      announce(SPAN_NOT_LOCATED_ANNOUNCEMENT, "polite");
      return;
    }
    markRefs.current.get(segmentKey(currentJumpSegment))?.focus();
    announce(jump.announcement, "polite");
  }, [jump, currentJumpSegment, announce]);

  const returnFocus = useCallback(() => {
    jump?.returnFocusTo?.focus();
  }, [jump]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && currentJumpSegment !== null) {
        event.preventDefault();
        returnFocus();
      }
    },
    [currentJumpSegment, returnFocus],
  );

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !containerRef.current?.contains(next)) {
        setDismissedSeq(jump?.seq ?? null);
      }
    },
    [jump],
  );

  const showBackControl = currentJumpSegment !== null && Boolean(jump) && dismissedSeq !== jump?.seq;

  return (
    <div className="flex flex-col gap-3">
      {inputMode === "native_document" && (
        <>
          <ScannedNotice inputMode="native_document" />
          <p className="text-xs font-medium text-muted-foreground">Transcribed from an image — not independent evidence.</p>
        </>
      )}
      <section
        ref={containerRef}
        data-document-id={documentId}
        tabIndex={0}
        aria-label={label ?? "Document text"}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        // font-reading, not the arbitrary-value font-[family-name:var(--font-reading)] this used to
        // read: --font-reading lives in an `@theme inline` block (globals.css), which Tailwind
        // inlines only into utilities it generates itself — an arbitrary var() reference to that
        // name from outside never resolves to a real custom property, so the whole font-family
        // declaration is invalid and silently falls back to the browser's default serif.
        className="mx-auto max-h-full max-w-[70ch] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-card p-4 font-reading text-sm leading-relaxed text-foreground [content-visibility:auto]"
      >
        {segments.map((segment) => {
          const key = segmentKey(segment);

          if (segment.tone === null) {
            return (
              <bdi key={key} style={BIDI_ISOLATE_STYLE}>
                {segment.text}
              </bdi>
            );
          }

          const focusable = segment.findingIds.some((id) => everJumpedIds.has(id)) || (jump != null && segment.findingIds.includes(jump.findingId));
          const isCurrentFinding = activeFindingId != null && segment.findingIds.includes(activeFindingId);

          return (
            // A Fragment, not a bare <HighlightMark>, so the "Back to finding" button below can sit
            // as the mark's own next sibling rather than its child — a child would leak into
            // mark.textContent, breaking "a matched mark's textContent equals spanText exactly."
            <Fragment key={key}>
              <HighlightMark
                ref={(node) => {
                  if (node) markRefs.current.set(key, node);
                  else markRefs.current.delete(key);
                }}
                tone={segment.tone}
                active={pulsingKeys?.has(key) ?? false}
                focusable={focusable}
                current={isCurrentFinding}
              >
                {segment.text}
              </HighlightMark>
              {/* Immediately after the LAST segment of the jumped-to quote in Tab order — an
                  overlap with another finding can split one quote into several marks, and this must
                  sit past all of them, never mid-quote — and, just as importantly, still a child of
                  the pane itself, so tabbing onto this button is never mistaken by handleBlur for
                  "focus left the document pane" and hidden out from under the very click that would
                  use it. */}
              {showBackControl && key === segmentKey(lastJumpSegment!) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={returnFocus}
                  className="relative mx-1 align-middle before:absolute before:-inset-2 before:content-['']"
                >
                  {backLabel ?? "Back to finding"}
                </Button>
              )}
            </Fragment>
          );
        })}
      </section>
    </div>
  );
}
