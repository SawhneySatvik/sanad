"use client";

/**
 * The analysis workspace's own client orchestrator: these screens' page.tsx files fetch nothing
 * server-side; every byte here comes from client-side TanStack Query. `page.tsx` stays a thin
 * server component that only awaits `params`/`searchParams` and hands the resolved id/lens down —
 * this file owns everything else: data, layout choice, and every named state the workspace spec
 * describes.
 */

import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { ApiError, useIsOffline } from "@/lib/api";
import { useSession, sessionSignInAvailable } from "@/lib/session/use-session";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import type { DocumentWithFindingsOutput, FindingOutput } from "@/shared/contracts/documents";
import { bindSpan } from "@/lib/verification/bindSpan";

import { useDocumentQuery } from "./document/use-document-query";
import { useDocumentTextQuery } from "./document/use-document-text-query";
import { useAnalyzeMutation } from "./document/use-analyze-mutation";
import { DocumentPane } from "./document/document-pane";
import { NotReadyPanel } from "./document/not-ready-panel";
import { useLensState } from "./lens/use-lens-state";
import { useDocumentJump } from "./jump/use-document-jump";
import { useAskConversation } from "./ask/use-ask-conversation";
import { useVerifierSession } from "./verifier/use-verifier-session";
import { DocumentHeader } from "./header/document-header";
import { FindingsPane } from "./findings/findings-pane";
import { AskPanel } from "./ask/ask-panel";
import { AskComposer } from "./ask/ask-composer";
import { CATEGORY_LABELS } from "./findings/group-findings";
import { CITATION_HIGHLIGHT_FINDING_ID, type ExtraBoundEntry } from "./document/build-bound-entries";
import { ResizableWorkspaceSplit } from "./layout/resizable-split";
import { SegmentedFindingsAsk, type WorkspaceSegment } from "./layout/segmented-findings-ask";
import { WorkspaceBottomSheet } from "./layout/bottom-sheet";
import { useIsDesktopWorkspace } from "./layout/use-is-desktop";
import { WORKSPACE_HEIGHT_CLASS } from "./layout/workspace-height";
import { GENERIC_DOCUMENT_NOTICE, SAMPLE_NOTICE, jumpAnnouncement } from "./copy";

export interface WorkspaceClientProps {
  documentId: string;
  initialLensParam: string | null;
}

function WorkspaceSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function WorkspaceClient({ documentId, initialLensParam }: WorkspaceClientProps) {
  const documentQuery = useDocumentQuery(documentId);

  if (documentQuery.isLoading) {
    return <WorkspaceSkeleton />;
  }

  if (documentQuery.isError) {
    const code = documentQuery.error instanceof ApiError ? documentQuery.error.code : "INTERNAL_ERROR";
    const retryAfterSeconds = documentQuery.error instanceof ApiError ? documentQuery.error.retryAfterSeconds : undefined;
    // AppShell already renders the one standing OfflineBanner globally (an OFFLINE-coded failure
    // lands here too) — this page never mounts a second copy.
    return (
      <div className="p-6">
        <ErrorState code={code} retryAfterSeconds={retryAfterSeconds} onRetry={() => documentQuery.refetch()} />
      </div>
    );
  }

  // Unreachable in practice (isLoading/isError above cover every other TanStack Query status), but
  // narrows the type for the render below rather than asserting past it.
  if (!documentQuery.data) return null;

  // `key={documentId}`: a client-side navigation from one open document straight to another (a
  // RecentsList row, say) keeps this same route and component instance mounted — without a fresh
  // key, WorkspaceReady's own local state (the page-scoped Ask turns, the active jump/citation
  // highlight, which segment/sheet tab is open) would carry over onto the new document, and the
  // route-entry focus-to-<h1> effect below (mount-only, `[]` deps) would never refire. Forcing a
  // remount per document id is what makes both "fresh state per document" and "focus moves on every
  // client-side navigation into this screen" true at once.
  return <WorkspaceReady key={documentId} data={documentQuery.data} documentId={documentId} initialLensParam={initialLensParam} />;
}

function WorkspaceReady({
  data,
  documentId,
  initialLensParam,
}: {
  data: DocumentWithFindingsOutput;
  documentId: string;
  initialLensParam: string | null;
}) {
  const { document, analysisState, analysis } = data;
  const findings: FindingOutput[] = analysisState === "complete" ? data.findings : [];

  const session = useSession();
  const signInAvailable = sessionSignInAvailable(session);
  const isGuest = session.data?.kind !== "user";
  const isDesktop = useIsDesktopWorkspace();
  const isOffline = useIsOffline();

  const lens = useLensState(findings, document.documentType, initialLensParam);
  const textQuery = useDocumentTextQuery(documentId, document.processingStatus === "ready");
  const analyzeMutation = useAnalyzeMutation(documentId);
  const jump = useDocumentJump();
  const ask = useAskConversation(documentId);
  const verifier = useVerifierSession(documentId, textQuery.data, isOffline);

  const [segment, setSegment] = useState<WorkspaceSegment>("findings");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<WorkspaceSegment>("findings");
  const [citationHighlight, setCitationHighlight] = useState<ExtraBoundEntry | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Route-entry focus only — moves once per mount (the App Router doesn't reset focus on a
    // client-side navigation by default), never again on a later re-render of the same route.
    headingRef.current?.focus();
  }, []);

  // Stable across the sheet's own open/close cycle (unlike a FindingCard's own button, which
  // unmounts the moment the sheet closes) — Esc/"Back to finding" needs a real element to return
  // focus to even when the thing that triggered the jump no longer exists.
  const findingsTriggerRef = useRef<HTMLButtonElement>(null);
  const askTriggerRef = useRef<HTMLButtonElement>(null);
  // A jump requested from inside the sheet is dispatched from onCloseAutoFocus, once the sheet's own
  // exit animation (and the aria-hidden it holds over the rest of the page while open) has actually
  // finished — dispatching it eagerly, before the sheet finishes closing, would announce into a
  // still-inert page and race Radix's own focus-return.
  const pendingPhoneJumpRef = useRef<{ kind: "finding"; finding: FindingOutput } | { kind: "citation"; citation: AskCitationOutput } | null>(null);

  function handleShowInDocument(finding: FindingOutput, element: HTMLElement | null) {
    setCitationHighlight(null);
    jump.activate({ findingId: finding.id, announcement: jumpAnnouncement(CATEGORY_LABELS[finding.category]), returnFocusTo: element });
  }

  function handleCitationClick(citation: AskCitationOutput) {
    if (!citation.sourceDocumentId || !textQuery.data) return;
    const bound = bindSpan(citation.verification, textQuery.data, { documentId: citation.sourceDocumentId });
    if (!bound) return; // stale/mismatched hash — the citation's own QuoteBlock/badge stay unaffected, nothing pulses
    setCitationHighlight({ findingId: CITATION_HIGHLIGHT_FINDING_ID, range: bound, tone: citation.verification.status === "approximate" ? "approximate" : "default" });
    // No stable element to return focus to: CitationChip's own onActivate exposes no element, so
    // Esc from this jump simply leaves focus on the mark.
    jump.activate({ findingId: CITATION_HIGHLIGHT_FINDING_ID, announcement: "Showing this citation in the document.", returnFocusTo: null });
  }

  function handleSend(value: string) {
    ask.send(value);
    setSegment("ask");
  }

  // Stashes only plain data (never a ref read) — the deferred dispatcher below is the one place
  // that reads findingsTriggerRef/askTriggerRef, and only once Radix actually calls it.
  function handlePhoneShowInDocument(finding: FindingOutput) {
    pendingPhoneJumpRef.current = { kind: "finding", finding };
    setSheetOpen(false);
  }

  function handlePhoneCitationClick(citation: AskCitationOutput) {
    pendingPhoneJumpRef.current = { kind: "citation", citation };
    setSheetOpen(false);
  }

  function handleSheetCloseAutoFocus(event: Event) {
    const pending = pendingPhoneJumpRef.current;
    if (!pending) return; // an ordinary Esc/backdrop close — Radix's own return-focus-to-trigger stands
    event.preventDefault();
    pendingPhoneJumpRef.current = null;
    // Both trigger refs are button elements this same phone render always mounts alongside the
    // sheet itself, so one of the two is normally set; handleShowInDocument tolerates null all the
    // same rather than asserting past a ref that, in principle, hasn't attached yet.
    if (pending.kind === "finding") handleShowInDocument(pending.finding, findingsTriggerRef.current ?? askTriggerRef.current);
    else handleCitationClick(pending.citation);
  }

  const documentLabel = document.title;

  const documentHeader = (
    <>
      {document.sampleId !== null && (
        <div className="px-4 pt-3">
          {/* line-clamp-1 is display only — toPlainText() (InlineNotice's own live-region announce)
              recurses into this span's children regardless, so the full sentence still reaches an
              AT user even though phone shows only its first line. Desktop has room for the whole
              sentence, so it renders unclamped there. */}
          <InlineNotice>{isDesktop ? SAMPLE_NOTICE : <span className="line-clamp-1">{SAMPLE_NOTICE}</span>}</InlineNotice>
        </div>
      )}
      <DocumentHeader
        ref={headingRef}
        document={document}
        analysis={analysis}
        lensOptions={lens.options}
        activeLens={lens.activeLens}
        onLensChange={lens.setActiveLens}
        signInAvailable={signInAvailable}
        isGuest={isGuest}
        isDesktop={isDesktop}
      />
      {document.documentType === "generic" && (
        <div className="px-4 pb-3">
          <InlineNotice>{GENERIC_DOCUMENT_NOTICE}</InlineNotice>
        </div>
      )}
    </>
  );

  // The document column's own content follows processingStatus, independent of analysisState: a
  // "ready" document shows its real text even before its first analysis, "pending"/
  // "extraction_failed" show the same not-ready panel FindingsPane uses — minus its own action
  // button, which lives in the findings pane alone (see not-ready-panel.tsx).
  const extraHighlights = [verifier.highlightEntry, citationHighlight].filter((entry): entry is ExtraBoundEntry => entry !== null);
  const documentPaneContent =
    document.processingStatus === "ready" ? (
      <DocumentPane
        documentId={documentId}
        findings={findings}
        textQuery={textQuery}
        jump={jump.jump}
        activeFindingId={jump.activeFindingId}
        extraHighlights={extraHighlights}
      />
    ) : (
      <NotReadyPanel document={document} tooLong={analyzeMutation.tooLong} onAnalyse={analyzeMutation.analyse} isAnalysing={analyzeMutation.isAnalysing} showAction={false} />
    );

  // `variant`, not a callback parameter: both handlers already live in this same closure scope, and
  // choosing between them with a local reference (rather than an argument passed into this
  // function's own call) is what keeps handlePhoneShowInDocument's ref reads out of an eslint
  // pattern it can't statically prove is deferred to an event handler.
  function renderFindingsPane(variant: "desktop" | "phone") {
    if (analysisState !== "complete") {
      return (
        <NotReadyPanel
          document={document}
          tooLong={analyzeMutation.tooLong}
          onAnalyse={analyzeMutation.analyse}
          isAnalysing={analyzeMutation.isAnalysing}
          error={analyzeMutation.error}
        />
      );
    }
    const onShowInDocument = variant === "phone" ? handlePhoneShowInDocument : handleShowInDocument;
    return (
      <FindingsPane
        findings={findings}
        activeLens={lens.activeLens}
        activeFindingId={jump.activeFindingId}
        onShowInDocument={onShowInDocument}
        onTestQuote={verifier.startTesting}
        testingFindingId={verifier.testingFindingId}
        renderVerifierDemo={verifier.renderVerifierDemo}
        inputMode={textQuery.data?.inputMode}
      />
    );
  }

  const findingsPaneContent = renderFindingsPane("desktop");

  const askPanelContent = (
    <AskPanel conversation={ask} documentId={documentId} documentLabel={documentLabel} onCitationClick={handleCitationClick} alwaysPresentLog={!isDesktop} />
  );

  const composer = (
    <AskComposer value={ask.composerValue} onChange={ask.setComposerValue} onSend={handleSend} disabled={isOffline} sendDisabled={ask.status === "streaming"} />
  );

  if (isDesktop) {
    return (
      <ResizableWorkspaceSplit
        documentPane={<div className="min-h-0 flex-1 overflow-y-auto p-4">{documentPaneContent}</div>}
        rightPane={
          <div className="flex min-h-0 flex-1 flex-col">
            {documentHeader}
            <SegmentedFindingsAsk value={segment} onChange={setSegment} findingsPanel={findingsPaneContent} askPanel={askPanelContent} />
            {composer}
          </div>
        }
      />
    );
  }

  function openSheet(tab: WorkspaceSegment) {
    setSheetTab(tab);
    setSheetOpen(true);
  }

  const phoneFindingsPane = renderFindingsPane("phone");
  const phoneAskPanel = (
    <AskPanel conversation={ask} documentId={documentId} documentLabel={documentLabel} onCitationClick={handlePhoneCitationClick} alwaysPresentLog />
  );

  return (
    <div className={`flex flex-col ${WORKSPACE_HEIGHT_CLASS}`}>
      {documentHeader}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{documentPaneContent}</div>
      {/* One full-width segmented handle (two real buttons sharing a single outline, not two
          separately-outlined ones) so findings show up above the fold instead of two islands of
          chrome eating the first viewport — findingsTriggerRef/askTriggerRef still need to be real
          buttons of their own, since handleSheetCloseAutoFocus returns focus to whichever one opened
          the sheet. Hidden (with the composer) while the sheet itself covers this same row. */}
      {!sheetOpen && (
        <>
          <div className="border-t border-border p-3">
            <div className="flex overflow-hidden rounded-lg border border-border">
              <button
                ref={findingsTriggerRef}
                type="button"
                className="min-h-11 flex-1 border-r border-border px-3 text-sm font-medium"
                onClick={() => openSheet("findings")}
              >
                {findings.length} finding{findings.length === 1 ? "" : "s"}
              </button>
              <button ref={askTriggerRef} type="button" className="min-h-11 flex-1 px-3 text-sm font-medium" onClick={() => openSheet("ask")}>
                Ask
              </button>
            </div>
          </div>
          {composer}
        </>
      )}
      <WorkspaceBottomSheet open={sheetOpen} onOpenChange={setSheetOpen} title="Findings and Ask" onCloseAutoFocus={handleSheetCloseAutoFocus}>
        <SegmentedFindingsAsk value={sheetTab} onChange={setSheetTab} findingsPanel={phoneFindingsPane} askPanel={phoneAskPanel} />
        {sheetOpen && composer}
      </WorkspaceBottomSheet>
    </div>
  );
}
