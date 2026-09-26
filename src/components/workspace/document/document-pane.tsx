"use client";

/**
 * The document column's own content: GET /api/documents/:id/text's independent failure surface —
 * a 404/429/500/offline here never blocks FindingsPane or any QuoteBlock, which don't depend on
 * this call; only the inline highlight is withheld until it recovers.
 */

import { useMemo } from "react";
import { DocumentViewer, type DocumentViewerJump } from "@/components/document/document-viewer";
import { ErrorState } from "@/components/feedback/error-state";
import { useIsOffline, ApiError } from "@/lib/api";
import { segmentDocumentText, type Segment } from "@/lib/verification/segmentDocumentText";
import type { DocumentTextOutput } from "@/shared/contracts/document-text";
import type { FindingOutput } from "@/shared/contracts/documents";
import { buildBoundEntries, type ExtraBoundEntry } from "./build-bound-entries";
import { DOCUMENT_TEXT_LABEL, BACK_TO_FINDING_LABEL } from "../copy";
import type { UseQueryResult } from "@tanstack/react-query";

export interface DocumentPaneProps {
  documentId: string;
  findings: readonly FindingOutput[];
  textQuery: UseQueryResult<DocumentTextOutput>;
  jump: DocumentViewerJump | null;
  activeFindingId: string | null;
  /** Synthetic segments with no backing finding — the verifier demo's live mark, a clicked citation's own bound span. */
  extraHighlights: readonly ExtraBoundEntry[];
}

export function DocumentPane({ documentId, findings, textQuery, jump, activeFindingId, extraHighlights }: DocumentPaneProps) {
  const isOffline = useIsOffline();

  const segments: Segment[] = useMemo(() => {
    if (!textQuery.data) return [];
    const bound = buildBoundEntries(documentId, findings, textQuery.data, [...extraHighlights]);
    return segmentDocumentText(textQuery.data.text, bound);
  }, [documentId, findings, textQuery.data, extraHighlights]);

  if (textQuery.isError) {
    const code = textQuery.error instanceof ApiError ? textQuery.error.code : "INTERNAL_ERROR";
    const retryAfterSeconds = textQuery.error instanceof ApiError ? textQuery.error.retryAfterSeconds : undefined;
    // AppShell already shows the one standing OfflineBanner globally — this pane never renders a
    // second copy, only disables its own "Retry" while offline.
    return <ErrorState code={code} retryAfterSeconds={retryAfterSeconds} onRetry={isOffline ? undefined : () => textQuery.refetch()} />;
  }

  if (!textQuery.data) {
    // No visible spinner for a same-session fetch (F1/F2's own States row) — the reading pane is
    // simply empty until it resolves.
    return null;
  }

  return (
    <DocumentViewer
      documentId={documentId}
      segments={segments}
      inputMode={textQuery.data.inputMode}
      activeFindingId={activeFindingId}
      label={DOCUMENT_TEXT_LABEL}
      backLabel={BACK_TO_FINDING_LABEL}
      jump={jump}
    />
  );
}
