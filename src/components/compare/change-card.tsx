"use client";

/**
 * One aligned change, both sides. An <article>, never a <button> — its "Show this change"/"Open in
 * document" controls and each side's VerificationBadge info button are independent siblings, none
 * nested inside another (matching FindingCard's own pattern). changeType is icon + text, never
 * colour alone (no green/red pair — that would smuggle severity/ranking back in).
 */

import Link from "next/link";
import { ArrowUpRight, Minus, Plus, RefreshCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuoteBlock } from "@/components/verification/quote-block";
import { AiLabel } from "@/components/verification/ai-label";
import { VerificationInfoButton } from "@/components/workspace/findings/verification-info-button";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import {
  CHANGE_TYPE_LABELS,
  COULD_NOT_RECHECK_LABEL,
  OPEN_IN_DOCUMENT_LABEL,
  SHOW_THIS_CHANGE_LABEL,
  notPresentLabel,
} from "./copy";

export type ComparisonChange = ComparisonWithChangesOutput["changes"][number];

const CHANGE_TYPE_ICONS: Record<ComparisonChange["changeType"], LucideIcon> = {
  added: Plus,
  removed: Minus,
  changed: RefreshCw,
};

export interface ChangeCardProps {
  change: ComparisonChange;
  active: boolean;
  /** The element argument is the clicked button itself — reused deliberately for the same reason
   * use-document-jump.ts's own header comment gives: a click does not always leave
   * document.activeElement pointing at the control that triggered it, so the host captures the
   * real element instead of re-deriving it later. */
  onSelect: (id: string, element: HTMLElement) => void;
  /** Resolved by the caller from comparison.documentAId/documentBId: removed opens A, added/changed
   * open the newer version, B. */
  openDocumentId: string;
}

function nullSideCopy(changeType: ComparisonChange["changeType"], side: "A" | "B"): string {
  if (changeType === "added" && side === "A") return notPresentLabel("A");
  if (changeType === "removed" && side === "B") return notPresentLabel("B");
  return COULD_NOT_RECHECK_LABEL;
}

function Side({ side, verification, changeType }: { side: "A" | "B"; verification: ComparisonChange["verificationA"]; changeType: ComparisonChange["changeType"] }) {
  if (!verification) {
    return <p data-side={side} className="text-sm text-muted-foreground">{nullSideCopy(changeType, side)}</p>;
  }
  return (
    // items-start puts the ⓘ button on the same top line as QuoteBlock's own badge (its first
    // child) rather than below the whole quote — QuoteBlock is verification/'s own file, not this
    // one's to restructure internally, so this sits it inline from the outside instead.
    <div data-side={side} className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <QuoteBlock verification={verification} />
      </div>
      <VerificationInfoButton status={verification.status} />
    </div>
  );
}

export function ChangeCard({ change, active, onSelect, openDocumentId }: ChangeCardProps) {
  const Icon = CHANGE_TYPE_ICONS[change.changeType];
  const label = CHANGE_TYPE_LABELS[change.changeType];

  return (
    <article
      aria-current={active ? "true" : undefined}
      data-change-id={change.id}
      data-change-type={change.changeType}
      data-active={active || undefined}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 data-[active=true]:border-ring"
    >
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
      </div>

      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm text-foreground">{change.explanation}</p>
        <AiLabel provenance={change.explanationProvenance} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Side side="A" verification={change.verificationA} changeType={change.changeType} />
        <Side side="B" verification={change.verificationB} changeType={change.changeType} />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-change-select={change.id}
          onClick={(event) => onSelect(change.id, event.currentTarget)}
          className="relative inline-flex min-h-[44px] items-center rounded-md px-2 text-sm font-medium text-primary before:absolute before:-inset-1 before:content-[''] hover:underline"
        >
          {SHOW_THIS_CHANGE_LABEL}
        </button>
        <Button asChild variant="outline" size="sm">
          <Link href={`/documents/${openDocumentId}`}>
            <ArrowUpRight aria-hidden="true" />
            {OPEN_IN_DOCUMENT_LABEL}
          </Link>
        </Button>
      </div>
    </article>
  );
}
