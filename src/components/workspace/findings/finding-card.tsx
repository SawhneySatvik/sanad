"use client";

/**
 * One finding: an <article>, never a <button> — a whole-card button wrapping the badge's
 * info button plus two more actions would be nested interactive content. Its <h3>, QuoteBlock
 * (display only) and three sibling <button>s — "Show in document," "Test this quote," the badge's
 * info button — are each independently reachable; none is nested inside another.
 */

import type { ReactNode } from "react";
import { Eye, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuoteBlock } from "@/components/verification/quote-block";
import { VerificationInfoButton } from "./verification-info-button";
import type { FindingOutput } from "@/shared/contracts/documents";
import { CATEGORY_ICONS } from "./category-icons";
import { CATEGORY_LABELS } from "./group-findings";
import { CHECKLIST_CAPTION, SHOW_IN_DOCUMENT_LABEL, TEST_THIS_QUOTE_LABEL } from "../copy";

export interface FindingCardProps {
  finding: FindingOutput;
  activeLens: string | null;
  active: boolean;
  tabIndex: 0 | -1;
  onShowInDocument: (finding: FindingOutput, element: HTMLElement) => void;
  onTestQuote: (finding: FindingOutput) => void;
  /** Set only for the one card currently under "Test this quote" — renders VerifierDemo in place of the static QuoteBlock/badge row, never both at once. */
  verifierDemo?: ReactNode;
  /** Forwarded to QuoteBlock — see its own prop doc. */
  inputMode?: "text" | "native_document";
}

function resolveExplanation(finding: FindingOutput, activeLens: string | null): string {
  if (!activeLens) return finding.explanation;
  return finding.lensExplanations.find((entry) => entry.lens === activeLens)?.explanation ?? finding.explanation;
}

export function FindingCard({ finding, activeLens, active, tabIndex, onShowInDocument, onTestQuote, verifierDemo, inputMode }: FindingCardProps) {
  const Icon = CATEGORY_ICONS[finding.category];
  const categoryLabel = CATEGORY_LABELS[finding.category];
  const isChecklist = finding.explanationProvenance === "checklist";

  return (
    <article
      aria-current={active ? "true" : undefined}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 data-[active=true]:border-ring"
      data-active={active || undefined}
      data-finding-category={finding.category}
    >
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h3 className="text-sm font-medium text-foreground">{categoryLabel}</h3>
      </div>

      <p className="text-sm text-foreground">{resolveExplanation(finding, activeLens)}</p>

      {isChecklist ? (
        <p className="text-sm text-muted-foreground">{CHECKLIST_CAPTION}</p>
      ) : (
        finding.verification &&
        (verifierDemo ?? (
          <>
            <QuoteBlock verification={finding.verification} inputMode={inputMode} />
            {/* Both actions get the same small outline-button treatment — "Test this quote" used to
                read as disabled (muted text, no border) beside "Show in document"'s accent link
                styling, when both are equally live actions on this same quote. */}
            <div className="flex flex-wrap items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-roving="show-in-document"
                data-finding-id={finding.id}
                tabIndex={tabIndex}
                onClick={(event) => onShowInDocument(finding, event.currentTarget)}
                aria-label={`Show ${categoryLabel.toLowerCase()} in document`}
                className="min-h-11"
              >
                <Eye aria-hidden="true" />
                {SHOW_IN_DOCUMENT_LABEL}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => onTestQuote(finding)} className="min-h-11">
                <FlaskConical aria-hidden="true" />
                {TEST_THIS_QUOTE_LABEL}
              </Button>
              <VerificationInfoButton status={finding.verification.status} />
            </div>
          </>
        ))
      )}
    </article>
  );
}
