import { forwardRef, type ReactNode } from "react";
import { cn } from "cn";
import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";

export interface HighlightMarkProps {
  children: ReactNode;
  /** The transient one-shot flash on a finding-selection jump landing — a `ring` on top of
   * whatever `current`'s own wash already shows, distinguishing "just jumped here" from "this has
   * been the selected finding for a while," never background alone. */
  active?: boolean;
  tone?: "default" | "approximate";
  /** Only a mark a finding has jumped to gets a tabindex at all, and only ever -1 (never a Tab stop). */
  focusable?: boolean;
  /** The host's own "this is the currently selected finding" bookkeeping, exposed as a data
   * attribute for a caller or a test to key off — and, unlike the transient `active` flash, a real
   * persistent visual state of its own: every OTHER mark stays at rest (underline only, no wash),
   * so the one the reader picked keeps standing out long after `active`'s own pulse has faded. */
  current?: boolean;
}

/**
 * One highlight span inside DocumentViewer. Receives only bindSpan()'s already-decided text —
 * never raw spans plus the document's text together. `--mark`/`--mark-pulse` only, never
 * `--verified`: the badge's colour must never leak into the inline highlight, or a <mark> becomes a
 * second, unaudited renderer of "verified." Every tone carries a `--mark-underline` border — the
 * wash alone measures far below a highlight's own contrast floor against paper, so the underline
 * (not the wash) is the real non-colour conveyance; `approximate` is dashed instead of solid so it
 * differs by shape too, not only by the wash's hue. At rest (neither current nor active) a mark
 * carries no wash at all — with every finding's span washed gold at once, none of them reads as
 * "the one you picked"; only `current`'s own persistent wash earns that.
 */
export const HighlightMark = forwardRef<HTMLElement, HighlightMarkProps>(function HighlightMark(
  { children, active = false, tone = "default", focusable = false, current = false },
  ref,
) {
  return (
    <mark
      ref={ref}
      // Programmatic focus target only, never a Tab stop.
      tabIndex={focusable ? -1 : undefined}
      data-tone={tone}
      data-active={active || undefined}
      data-current-finding={current || undefined}
      style={BIDI_ISOLATE_STYLE}
      className={cn(
        // bg-transparent overrides the browser's own UA stylesheet (every <mark> is yellow by
        // default) — without it, "no wash at rest" silently reverts to that native yellow instead
        // of actually going away.
        "rounded-[1px] border-b border-mark-underline bg-transparent text-inherit",
        "transition-colors duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        tone === "approximate" && "border-dashed",
        current && "bg-mark-pulse border-b-2",
        active && "ring-2 ring-mark-underline",
      )}
    >
      {children}
    </mark>
  );
});
