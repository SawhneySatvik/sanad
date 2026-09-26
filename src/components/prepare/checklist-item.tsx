/**
 * One PrepareChecklistItemOutput, rendered as a real <li> — informational, never an interactive
 * checkbox; nothing here persists a "done" state. Same citation lookup pattern as
 * LawyerQuestionCard (see finding-citation.tsx).
 */

import { ListChecks } from "lucide-react";
import { AiLabel } from "@/components/verification/ai-label";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareChecklistItemOutput } from "./types";
import { FindingCitation } from "./finding-citation";

export interface ChecklistItemProps {
  item: PrepareChecklistItemOutput;
  documentFindings: readonly FindingOutput[];
}

export function ChecklistItem({ item, documentFindings }: ChecklistItemProps) {
  return (
    <li data-prepare-print-card className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start gap-2">
        <ListChecks aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <p className="flex-1 text-sm text-foreground">{item.item}</p>
        <AiLabel provenance="ai_generated" />
      </div>
      {item.findings.length > 0 && (
        <div className="flex flex-col gap-2 pl-6">
          {item.findings.map((citation) => (
            <FindingCitation key={citation.id} citation={citation} documentFindings={documentFindings} />
          ))}
        </div>
      )}
    </li>
  );
}
