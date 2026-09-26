/**
 * One PrepareQuestionOutput. Never a <button>: this card and its citations are display-only content
 * — there is no document viewer on this page to jump a citation into, so nothing here is ever
 * clickable, unlike the analysis workspace's own finding cards.
 */

import { AiLabel } from "@/components/verification/ai-label";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareQuestionOutput } from "./types";
import { FindingCitation } from "./finding-citation";

export interface LawyerQuestionCardProps {
  question: PrepareQuestionOutput;
  documentFindings: readonly FindingOutput[];
}

export function LawyerQuestionCard({ question, documentFindings }: LawyerQuestionCardProps) {
  return (
    <article data-prepare-print-card className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{question.question}</h3>
        <AiLabel provenance="ai_generated" />
      </div>
      <p className="text-sm text-muted-foreground">{question.whyItMatters}</p>
      {question.findings.length > 0 && (
        <div className="flex flex-col gap-2">
          {question.findings.map((citation) => (
            <FindingCitation key={citation.id} citation={citation} documentFindings={documentFindings} />
          ))}
        </div>
      )}
    </article>
  );
}
