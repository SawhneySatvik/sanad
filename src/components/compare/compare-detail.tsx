"use client";

/**
 * The comparison's own two-pane view, once both texts have loaded — pure presentation over already-
 * fetched data (comparison + textA + textB), so a component test can render this directly with
 * fixture props and exercise the real bindSpan -> segmentDocumentText -> DocumentViewer/ChangeCard
 * path with no fetch mocking at all.
 *
 * One activation, one side, one announcement: DocumentViewer's own jump prop drives both focus AND
 * the pulse from a single state, so two simultaneously-live jumps would fight over real DOM focus
 * and double-announce — only the winning side (A if bound, else B) ever gets a jump prop;
 * the other side's DocumentViewer receives `jump={null}` for that activation. `activeFindingId` still
 * goes to both panes, so the non-focused side's resting mark is marked "current" without moving
 * focus or re-announcing.
 */

import { useMemo, useRef, useState } from "react";
import { DocumentViewer, type DocumentViewerJump } from "@/components/document/document-viewer";
import { ModelUsedNote } from "@/components/verification/model-used-note";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { segmentDocumentText } from "@/lib/verification/segmentDocumentText";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import type { DocumentTextOutput } from "@/shared/contracts/document-text";
import { buildSideEntries } from "./build-side-entries";
import type { ComparisonChange } from "./change-card";
import { CompareSummaryBar } from "./compare-summary-bar";
import { resolveOpenDocumentId } from "./resolve-open-document-id";
import { useIsCompareDesktop } from "./use-is-compare-desktop";
import { BACK_TO_CHANGES_LABEL, TABS_A_LABEL, TABS_B_LABEL, TAB_CHANGES_LABEL, paneLabel, sideJumpAnnouncement } from "./copy";

export interface CompareDetailProps {
  comparison: ComparisonWithChangesOutput;
  textA: DocumentTextOutput;
  textB: DocumentTextOutput;
}

type PhoneTab = "A" | "B" | "changes";

export function CompareDetail({ comparison, textA, textB }: CompareDetailProps) {
  const isDesktop = useIsCompareDesktop();
  const [expanded, setExpanded] = useState(false);
  const [activeChangeId, setActiveChangeId] = useState<string | null>(null);
  const [jumpA, setJumpA] = useState<DocumentViewerJump | null>(null);
  const [jumpB, setJumpB] = useState<DocumentViewerJump | null>(null);
  const [phoneTab, setPhoneTab] = useState<PhoneTab>("changes");
  const seqRef = useRef(0);
  const changesTabTriggerRef = useRef<HTMLButtonElement>(null);

  const entriesA = useMemo(() => buildSideEntries("A", comparison, textA), [comparison, textA]);
  const entriesB = useMemo(() => buildSideEntries("B", comparison, textB), [comparison, textB]);
  const segmentsA = useMemo(() => segmentDocumentText(textA.text, entriesA), [textA, entriesA]);
  const segmentsB = useMemo(() => segmentDocumentText(textB.text, entriesB), [textB, entriesB]);

  function handleSelectChange(change: ComparisonChange, element: HTMLElement) {
    const boundOnA = entriesA.some((entry) => entry.findingId === change.id);
    const boundOnB = entriesB.some((entry) => entry.findingId === change.id);
    seqRef.current += 1;
    const seq = seqRef.current;
    setActiveChangeId(change.id);

    // On phone, the card that was clicked lives inside the Changes tab, which stays mounted (the
    // trigger, not the panel) once the view switches to A/B — the panel's own button does not.
    const returnFocusTo = isDesktop ? element : (changesTabTriggerRef.current ?? element);
    if (!isDesktop) setPhoneTab(boundOnB && !boundOnA ? "B" : "A");

    if (boundOnA) {
      setJumpB(null);
      setJumpA({ findingId: change.id, seq, announcement: sideJumpAnnouncement("A"), returnFocusTo });
    } else if (boundOnB) {
      setJumpA(null);
      setJumpB({ findingId: change.id, seq, announcement: sideJumpAnnouncement("B"), returnFocusTo });
    } else {
      // Neither side rebinds: DocumentViewer's own null-bind path announces "couldn't be located"
      // and leaves focus where it was — jumping A (never both) is what keeps this to one announcement.
      setJumpB(null);
      setJumpA({ findingId: change.id, seq, announcement: sideJumpAnnouncement("A"), returnFocusTo });
    }
  }

  function handlePhoneTabChange(next: string) {
    // A manual switch, not a selection — clears any live jump so the newly (re)mounted
    // DocumentViewer never re-focuses/re-announces a jump it never chose (a fresh mount's own
    // announcedSeq ref starts null, which would otherwise look like a brand new jump to it).
    setJumpA(null);
    setJumpB(null);
    setPhoneTab(next as PhoneTab);
  }

  function renderChanges(forceExpanded: boolean) {
    return (
      <CompareSummaryBar
        changes={comparison.changes}
        expanded={forceExpanded || expanded}
        onToggle={() => setExpanded((value) => !value)}
        activeChangeId={activeChangeId}
        onSelectChange={(id, element) => {
          const change = comparison.changes.find((candidate) => candidate.id === id);
          if (change) handleSelectChange(change, element);
        }}
        resolveOpenDocumentId={(change) => resolveOpenDocumentId(change, comparison)}
      />
    );
  }

  const paneA = (
    <DocumentViewer
      documentId={comparison.documentAId}
      segments={segmentsA}
      inputMode={textA.inputMode}
      activeFindingId={activeChangeId}
      label={paneLabel("A", comparison.titleA)}
      backLabel={BACK_TO_CHANGES_LABEL}
      jump={jumpA}
    />
  );
  const paneB = (
    <DocumentViewer
      documentId={comparison.documentBId}
      segments={segmentsB}
      inputMode={textB.inputMode}
      activeFindingId={activeChangeId}
      label={paneLabel("B", comparison.titleB)}
      backLabel={BACK_TO_CHANGES_LABEL}
      jump={jumpB}
    />
  );

  const modelNote = comparison.modelUsed !== "none" && <ModelUsedNote modelUsed={comparison.modelUsed} sampleId={null} />;

  if (isDesktop) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        {renderChanges(false)}
        {modelNote}
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
          <section aria-label={paneLabel("A", comparison.titleA)}>{paneA}</section>
          <section aria-label={paneLabel("B", comparison.titleB)}>{paneB}</section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 p-6">
      {modelNote}
      <Tabs value={phoneTab} onValueChange={handlePhoneTabChange}>
        <TabsList>
          <TabsTrigger value="A">{TABS_A_LABEL}</TabsTrigger>
          <TabsTrigger value="B">{TABS_B_LABEL}</TabsTrigger>
          <TabsTrigger ref={changesTabTriggerRef} value="changes">
            {TAB_CHANGES_LABEL}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="A">{paneA}</TabsContent>
        <TabsContent value="B">{paneB}</TabsContent>
        <TabsContent value="changes">{renderChanges(true)}</TabsContent>
      </Tabs>
    </div>
  );
}
