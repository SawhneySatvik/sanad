/**
 * Renders prepare's own structured data only — never the raw `markdown` string as content (that
 * string exists solely for ExportMenu's Download action). documentFindings is what resolves the
 * badge-collision ruling: every citation below is looked up against it, never against
 * PrepareFindingRefOutput.verification (see finding-citation.tsx).
 */

import { EmptyState } from "@/components/feedback/empty-state";
import { PageHeader } from "@/components/page/page-header";
import { ModelUsedNote } from "@/components/verification/model-used-note";
import { lensLabel } from "@/shared/lens-labels";
import { LEGAL_ADVICE_COPY } from "@/shared/copy/legal-advice";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareOutput } from "@/shared/contracts/prepare";
import { LawyerQuestionCard } from "./lawyer-question-card";
import { ChecklistItem } from "./checklist-item";
import {
  AI_GENERATED_NOTICE,
  CHECKLIST_HEADING,
  EXTRACTION_FAILED_BODY,
  EXTRACTION_FAILED_HEADING,
  GO_TO_DOCUMENT_LABEL,
  NOT_ANALYZED_BODY,
  NOT_ANALYZED_HEADING,
  NO_GROUNDED_FINDINGS_BODY,
  NO_GROUNDED_FINDINGS_HEADING,
  QUESTIONS_HEADING,
  preparedForHeading,
} from "./copy";

export interface PrepareViewProps {
  prepare: PrepareOutput;
  documentFindings: readonly FindingOutput[];
  onGoToDocument: () => void;
  /** processingStatus, so the not_analyzed state (reachable only defensively — PrepareClient's own
   * GET-gating normally intercepts this first) can still tell an unread document from an unanalysed one. */
  extractionFailed?: boolean;
  /** TanStack Query's dataUpdatedAt for this result — PrepareOutput itself carries no timestamp; this is the closest honest stand-in for the print header's "generated on" line. */
  generatedAt?: Date;
}

export function PrepareView({ prepare, documentFindings, onGoToDocument, extractionFailed, generatedAt }: PrepareViewProps) {
  if (prepare.state === "not_analyzed") {
    return extractionFailed ? (
      <EmptyState heading={EXTRACTION_FAILED_HEADING} body={EXTRACTION_FAILED_BODY} action={{ label: GO_TO_DOCUMENT_LABEL, onClick: onGoToDocument }} />
    ) : (
      <EmptyState heading={NOT_ANALYZED_HEADING} body={NOT_ANALYZED_BODY} action={{ label: GO_TO_DOCUMENT_LABEL, onClick: onGoToDocument }} />
    );
  }

  if (prepare.state === "no_grounded_findings") {
    return (
      <EmptyState heading={NO_GROUNDED_FINDINGS_HEADING} body={NO_GROUNDED_FINDINGS_BODY} action={{ label: GO_TO_DOCUMENT_LABEL, onClick: onGoToDocument }} />
    );
  }

  const heading = preparedForHeading(lensLabel(prepare.lens));

  return (
    <div className="flex flex-col gap-6">
      {/* Real in-flow content for the printed page, never aria-hidden decoration — hidden on
          screen, where the h1 right below already carries the same information. */}
      <div className="hidden print:block text-sm">
        <p>{heading}</p>
        {generatedAt && <p>{generatedAt.toLocaleDateString()}</p>}
      </div>

      <PageHeader title={heading} />

      <div role="note" className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p>{LEGAL_ADVICE_COPY.prepareNotice}</p>
        <p>{AI_GENERATED_NOTICE}</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-medium text-foreground">{QUESTIONS_HEADING}</h2>
        <div className="flex flex-col gap-3">
          {prepare.lawyerQuestions.map((question, index) => (
            <LawyerQuestionCard key={index} question={question} documentFindings={documentFindings} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-medium text-foreground">{CHECKLIST_HEADING}</h2>
        <ul className="flex flex-col gap-3">
          {prepare.checklist.map((item, index) => (
            <ChecklistItem key={index} item={item} documentFindings={documentFindings} />
          ))}
        </ul>
      </section>

      <ModelUsedNote modelUsed={prepare.modelUsed} />
    </div>
  );
}
