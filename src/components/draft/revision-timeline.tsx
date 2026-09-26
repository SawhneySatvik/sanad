"use client";

/**
 * The draft's whole revision chain, fed by exactly one GET /api/drafts/:id/revisions response —
 * every revision sharing the root, not just this one's ancestors. Rendered linearly (oldest to
 * newest); a "from revision N" note appears on any entry whose parentDraftId isn't the entry
 * immediately before it in that order. "Go to latest" reads `isLatest` directly off the matching
 * entry, never "is this the last item in the array" — a reordered or truncated response still
 * renders it correctly.
 *
 * Phone: the list collapses behind a "Revisions (N)" trigger that opens a bottom sheet — never both
 * an inline copy and a sheet copy in the DOM at once, which would give two aria-current nodes for
 * the same entry.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { DraftRevisionEntry } from "./types";
import { fromRevisionNote, GO_TO_LATEST_LABEL, INSTRUCTIONS_NOT_RECORDED, REVISIONS_TRIGGER_LABEL, revisionLabel } from "./copy";
import { RevisionsBottomSheet } from "./revisions-bottom-sheet";
import { useIsDesktop } from "./use-is-desktop";

export interface RevisionTimelineProps {
  revisions: DraftRevisionEntry[];
  onSelectRevision: (draftId: string) => void;
  onGoToLatest: () => void;
}

function orderedRevisions(revisions: DraftRevisionEntry[]): DraftRevisionEntry[] {
  return [...revisions].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function branchNote(entry: DraftRevisionEntry, index: number, ordered: DraftRevisionEntry[]): string | null {
  if (index === 0) return null; // the root has no parent to branch from
  const immediatePredecessor = ordered[index - 1];
  if (entry.parentDraftId === immediatePredecessor.id) return null;
  const parent = ordered.find((candidate) => candidate.id === entry.parentDraftId);
  return parent ? fromRevisionNote(parent.revisionNumber) : null;
}

function RevisionTimelineList({ revisions, onSelectRevision, onGoToLatest }: RevisionTimelineProps) {
  const ordered = orderedRevisions(revisions);
  const currentIsLatest = ordered.some((entry) => entry.isCurrent && entry.isLatest);

  return (
    <ol className="flex flex-col gap-3">
      {ordered.map((entry, index) => {
        const note = branchNote(entry, index, ordered);
        return (
          <li key={entry.id}>
            <button
              type="button"
              aria-current={entry.isCurrent ? "true" : undefined}
              disabled={entry.isCurrent}
              onClick={() => onSelectRevision(entry.id)}
              className="flex min-h-11 w-full flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2 text-left aria-[current=true]:border-primary aria-[current=true]:bg-primary/5 disabled:cursor-default"
            >
              <span className="text-sm font-medium text-foreground">
                {revisionLabel(entry.revisionNumber)}
                {note && <span className="ml-2 text-xs font-normal text-muted-foreground">{note}</span>}
              </span>
              <span className="text-xs text-muted-foreground">
                {entry.userInstructions && entry.userInstructions.length > 0 ? entry.userInstructions : INSTRUCTIONS_NOT_RECORDED}
              </span>
            </button>
          </li>
        );
      })}
      {!currentIsLatest && (
        <li>
          <Button type="button" variant="outline" size="sm" onClick={onGoToLatest}>
            {GO_TO_LATEST_LABEL}
          </Button>
        </li>
      )}
    </ol>
  );
}

function DesktopRevisionTimeline(props: RevisionTimelineProps) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-display text-base font-medium text-foreground">Revisions</h2>
      <RevisionTimelineList {...props} />
    </div>
  );
}

function PhoneRevisionTimeline(props: RevisionTimelineProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {REVISIONS_TRIGGER_LABEL(props.revisions.length)}
      </Button>
      <RevisionsBottomSheet open={open} onOpenChange={setOpen} title="Revisions">
        <RevisionTimelineList {...props} />
      </RevisionsBottomSheet>
    </>
  );
}

export function RevisionTimeline(props: RevisionTimelineProps) {
  const isDesktop = useIsDesktop();
  return isDesktop ? <DesktopRevisionTimeline {...props} /> : <PhoneRevisionTimeline {...props} />;
}
