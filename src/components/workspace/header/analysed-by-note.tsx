/**
 * The whole-analysis model disclosure in DocumentHeader: "Analysed by <model>" (British spelling,
 * matching "Analyse now" elsewhere on this screen), from AnalysisOutput.modelUsed — the
 * "disclose which model produced this" convention every AI answer/draft carries, applied at the
 * analysis level, not per-finding (every ai_generated finding in one analysis shares the same model
 * by construction, and a checklist finding's modelUsed is the nonsensical literal "none").
 * FindingCard suppresses ModelUsedNote entirely and relies on this single instance instead.
 *
 * A dedicated component, not a reuse of verification/model-used-note.tsx: that component's copy is
 * fixed to "Answered by <model>" for an Ask turn and its own recorded-line wording — both distinct,
 * word-for-word, from this screen's own analysis-level copy.
 */

import { ChevronRight } from "lucide-react";

export interface AnalysedByNoteProps {
  modelUsed: string;
  /** DocumentOutput.sampleId — set only on a recorded sample, never a placeholder string. */
  sampleId?: string | null;
}

// `list-none` (plus the webkit-only pseudo it doesn't reach) drops the browser's own disclosure
// triangle so a themed lucide chevron can stand in for it instead — `<summary>` renders
// `display: list-item` by default, which is what paints that native marker in the first place.
export function AnalysedByNote({ modelUsed, sampleId }: AnalysedByNoteProps) {
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-open:rotate-90" strokeWidth={1.75} />
        <span className="text-xs text-muted-foreground">Analysed by {modelUsed}</span>
      </summary>
      {sampleId != null && <p className="mt-1">This analysis was recorded and replayed through the live verifier.</p>}
    </details>
  );
}
