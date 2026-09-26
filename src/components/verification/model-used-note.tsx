import { ChevronRight } from "lucide-react";

export interface ModelUsedNoteProps {
  modelUsed: string;
  /** DocumentOutput.sampleId — set only on a recorded sample, never a placeholder string. */
  sampleId?: string | null;
}

/**
 * "Answered by <model>" disclosure. Native <details>/<summary> needs no aria-expanded bookkeeping
 * of its own. `list-none` (plus the webkit-only pseudo it doesn't reach) drops the browser's own
 * disclosure triangle so a themed lucide chevron can stand in for it instead — `<summary>` renders
 * `display: list-item` by default, which is what paints that native marker in the first place. When
 * sampleId is set, a second line discloses this is a recorded output replayed through the real
 * pipeline, not a fresh call for this session — modelUsed still names the real model that originally
 * produced it.
 */
export function ModelUsedNote({ modelUsed, sampleId }: ModelUsedNoteProps) {
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-open:rotate-90" strokeWidth={1.75} />
        <span className="text-xs text-muted-foreground">Answered by {modelUsed}</span>
      </summary>
      {sampleId != null && <p className="mt-1">This is a recorded output, replayed through the real pipeline rather than freshly called for this session.</p>}
    </details>
  );
}
