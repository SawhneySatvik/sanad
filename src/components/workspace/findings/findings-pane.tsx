"use client";

/** Category-grouped findings (right pane / phone sheet tab), in DOCUMENT_CATEGORIES order — no ranking. */

import type { ReactNode } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import type { FindingOutput } from "@/shared/contracts/documents";
import { groupFindingsByCategory } from "./group-findings";
import { FindingGroup } from "./finding-group";
import { useRovingShowInDocument } from "./use-roving-show-in-document";
import { EMPTY_FINDINGS_HEADING } from "../copy";

export interface FindingsPaneProps {
  findings: readonly FindingOutput[];
  activeLens: string | null;
  activeFindingId: string | null;
  onShowInDocument: (finding: FindingOutput, element: HTMLElement) => void;
  onTestQuote: (finding: FindingOutput) => void;
  testingFindingId: string | null;
  renderVerifierDemo: (finding: FindingOutput) => ReactNode;
  /** Forwarded to each FindingCard's QuoteBlock — see its own prop doc. */
  inputMode?: "text" | "native_document";
}

export function FindingsPane({ findings, activeLens, activeFindingId, onShowInDocument, onTestQuote, testingFindingId, renderVerifierDemo, inputMode }: FindingsPaneProps) {
  // Destructured to plain locals: a member-expression read of a `*Ref`-named property tripped the
  // stricter react-hooks/refs lint rule's heuristic even for the non-ref members (onKeyDown,
  // onFocusCapture) alongside it.
  const { containerRef, onKeyDown, onFocusCapture, tabIndexFor } = useRovingShowInDocument();

  if (findings.length === 0) {
    return <EmptyState heading={EMPTY_FINDINGS_HEADING} headingLevel={2} />;
  }

  const groups = groupFindingsByCategory(findings);

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} onFocusCapture={onFocusCapture} className="flex flex-col">
      {groups.map((group, index) => (
        <FindingGroup
          key={group.category}
          group={group}
          activeFindingId={activeFindingId}
          tabIndexFor={tabIndexFor}
          onShowInDocument={onShowInDocument}
          onTestQuote={onTestQuote}
          activeLens={activeLens}
          isFirstGroup={index === 0}
          testingFindingId={testingFindingId}
          renderVerifierDemo={renderVerifierDemo}
          inputMode={inputMode}
        />
      ))}
    </div>
  );
}
