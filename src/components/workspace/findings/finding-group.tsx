"use client";

/**
 * One collapsible category group. Built on Collapsible (not the pre-built shadcn Accordion wrapper)
 * so this file controls the trigger's own heading level directly: Radix's Accordion.Header defaults
 * to <h3>, which would collide with FindingCard's own <h3> for the category label one level down —
 * this screen needs <h2> per group, <h3> per card.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CATEGORY_ICONS } from "./category-icons";
import { CATEGORY_LABELS, type FindingGroupData } from "./group-findings";
import { FindingCard, type FindingCardProps } from "./finding-card";
import type { FindingOutput } from "@/shared/contracts/documents";

export interface FindingGroupProps {
  group: FindingGroupData;
  defaultOpen?: boolean;
  activeFindingId: string | null;
  tabIndexFor: (findingId: string, isFirstRendered: boolean) => 0 | -1;
  onShowInDocument: FindingCardProps["onShowInDocument"];
  onTestQuote: FindingCardProps["onTestQuote"];
  activeLens: string | null;
  /** Whether this group contains the very first FindingCard in the whole pane — that one card's "Show in document" is the roving set's initial member. */
  isFirstGroup: boolean;
  testingFindingId: string | null;
  renderVerifierDemo: (finding: FindingOutput) => ReactNode;
  /** Forwarded to each FindingCard's QuoteBlock — see its own prop doc. */
  inputMode?: "text" | "native_document";
}

export function FindingGroup({ group, defaultOpen = true, activeFindingId, tabIndexFor, onShowInDocument, onTestQuote, activeLens, isFirstGroup, testingFindingId, renderVerifierDemo, inputMode }: FindingGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = CATEGORY_ICONS[group.category];
  const label = CATEGORY_LABELS[group.category];

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border last:border-b-0">
      <h2 className="flex">
        <CollapsibleTrigger
          className="flex flex-1 items-center gap-2 py-2.5 text-left text-sm font-medium text-foreground hover:underline"
          aria-label={`${label}, ${group.findings.length} finding${group.findings.length === 1 ? "" : "s"}`}
        >
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span>
            {label} <span className="text-muted-foreground">({group.findings.length})</span>
          </span>
          <ChevronDown aria-hidden="true" className={`ml-auto size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent className="flex flex-col gap-2 pb-3">
        {group.findings.map((finding, index) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            activeLens={activeLens}
            active={activeFindingId === finding.id}
            tabIndex={tabIndexFor(finding.id, isFirstGroup && index === 0)}
            onShowInDocument={onShowInDocument}
            onTestQuote={onTestQuote}
            verifierDemo={testingFindingId === finding.id ? renderVerifierDemo(finding) : undefined}
            inputMode={inputMode}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
