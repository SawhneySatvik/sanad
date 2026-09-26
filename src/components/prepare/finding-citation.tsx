/**
 * The badge-collision lookup: a Prepare citation's own verification field
 * (PrepareFindingRefOutput.verification) is never handed to VerificationBadge/QuoteBlock directly —
 * only the matching FindingOutput's own verification, looked up by id in the document's real
 * findings list, ever reaches those components. A model can write "F1" next to hostile text, but it
 * cannot alter what documentFindings actually holds, so this lookup is the one place a Prepare
 * citation's displayed status comes from. A stale id (no match — the document was re-analysed
 * elsewhere since this page's findings were fetched) renders its category icon only: no badge, no
 * quote, never a fallback to the citation's own PrepareFindingRefOutput.verification.
 */

import { CATEGORY_ICONS } from "@/components/workspace/findings/category-icons";
import { CATEGORY_LABELS } from "@/components/workspace/findings/group-findings";
import { QuoteBlock } from "@/components/verification/quote-block";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareFindingRefOutput } from "./types";
import { MISSING_CLAUSE_CITATION_LABEL } from "./copy";

export interface FindingCitationProps {
  citation: PrepareFindingRefOutput;
  documentFindings: readonly FindingOutput[];
}

export function FindingCitation({ citation, documentFindings }: FindingCitationProps) {
  const finding = documentFindings.find((candidate) => candidate.id === citation.id);
  const Icon = CATEGORY_ICONS[citation.category];
  const categoryLabel = CATEGORY_LABELS[citation.category];

  if (!finding) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        <span>{categoryLabel}</span>
      </div>
    );
  }

  if (finding.verification === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        <span>{CATEGORY_LABELS[finding.category]}</span>
        <span>{MISSING_CLAUSE_CITATION_LABEL}</span>
      </div>
    );
  }

  return <QuoteBlock verification={finding.verification} />;
}
