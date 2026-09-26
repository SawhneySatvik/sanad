"use client";

/**
 * "Summary of changes" — collapsed by default, so both documents keep maximum reading room. The
 * count beside the trigger is a plain count, not a ranking — changes are never ordered by severity.
 * Threads onSelectChange to every ChangeCard.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChangeCard, type ComparisonChange } from "./change-card";
import { NO_CHANGES_BODY, NO_CHANGES_TRIGGER_LABEL, SUMMARY_BAR_LABEL } from "./copy";

export interface CompareSummaryBarProps {
  changes: ComparisonChange[];
  expanded: boolean;
  onToggle: () => void;
  activeChangeId?: string | null;
  onSelectChange: (id: string, element: HTMLElement) => void;
  resolveOpenDocumentId: (change: ComparisonChange) => string;
}

export function CompareSummaryBar({ changes, expanded, onToggle, activeChangeId, onSelectChange, resolveOpenDocumentId }: CompareSummaryBarProps) {
  if (changes.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="text-sm font-medium text-foreground">{NO_CHANGES_TRIGGER_LABEL}</p>
        <p className="text-sm text-muted-foreground">{NO_CHANGES_BODY}</p>
      </div>
    );
  }

  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <CollapsibleTrigger className="relative flex min-h-[44px] w-full items-center justify-between rounded-lg border border-border bg-card px-3 text-left text-sm font-medium text-foreground">
        {`${SUMMARY_BAR_LABEL} (${changes.length})`}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2">
        {changes.map((change) => (
          <ChangeCard
            key={change.id}
            change={change}
            active={activeChangeId === change.id}
            onSelect={onSelectChange}
            openDocumentId={resolveOpenDocumentId(change)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
