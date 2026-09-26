"use client";

/**
 * Tracks which single finding (at most one at a time) is currently under "Test this quote," and the
 * live HighlightMark its own bindSpan()-derived result should drive in the shared DocumentViewer —
 * a synthetic segmentDocumentText() entry (VERIFIER_DEMO_FINDING_ID), never written into any real
 * finding's own state (the verifier demo's "never mutates" guarantee).
 */

import { useCallback, useState, type ReactNode } from "react";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { DocumentTextOutput } from "@/shared/contracts/document-text";
import { VerifierDemo, type VerifierDemoHighlight } from "./verifier-demo";
import { VERIFIER_DEMO_FINDING_ID, type ExtraBoundEntry } from "../document/build-bound-entries";

export interface UseVerifierSessionResult {
  testingFindingId: string | null;
  startTesting: (finding: FindingOutput) => void;
  highlightEntry: ExtraBoundEntry | null;
  renderVerifierDemo: (finding: FindingOutput) => ReactNode;
}

function seedTextFor(finding: FindingOutput): string {
  const verification = finding.verification;
  if (!verification) return "";
  return verification.status === "not_found" ? verification.claimedQuote : verification.spanText;
}

export function useVerifierSession(documentId: string, documentText: DocumentTextOutput | undefined, disabled = false): UseVerifierSessionResult {
  const [testingFindingId, setTestingFindingId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<VerifierDemoHighlight | null>(null);

  const startTesting = useCallback((finding: FindingOutput) => {
    setTestingFindingId(finding.id);
    setHighlight(null);
  }, []);

  const stopTesting = useCallback(() => {
    setTestingFindingId(null);
    setHighlight(null);
  }, []);

  const renderVerifierDemo = useCallback(
    (finding: FindingOutput) => {
      if (!finding.verification) return null;
      return (
        <VerifierDemo
          key={finding.id}
          documentId={documentId}
          initialText={seedTextFor(finding)}
          documentText={documentText}
          onHighlightChange={setHighlight}
          onDone={stopTesting}
          disabled={disabled}
        />
      );
    },
    [documentId, documentText, stopTesting, disabled],
  );

  // Carries bindSpan()'s own already-decided spanText straight through — never re-sliced here,
  // which would be a second, redundant place deciding what text a bound range covers.
  const highlightEntry: ExtraBoundEntry | null = highlight
    ? {
        findingId: VERIFIER_DEMO_FINDING_ID,
        range: { spanStart: highlight.spanStart, spanEnd: highlight.spanEnd, spanText: highlight.spanText },
        tone: highlight.tone,
      }
    : null;

  return { testingFindingId, startTesting, highlightEntry, renderVerifierDemo };
}
