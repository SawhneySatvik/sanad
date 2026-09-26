"use client";

/**
 * The shared "nothing to show yet" content for a `not_analyzed` document — rendered in place of
 * both the document pane's own text and FindingsPane's list: the document column shows the same
 * EmptyState as FindingsPane's not_analyzed row instead of an empty reading pane. Never shown for
 * `analysisState: "complete"`.
 *
 * `showAction` is false for the document-column instance: two independent "Analyse now"/"Upload
 * again" buttons wired to the same mutation is a duplicate-control hygiene bug (two identically-
 * labelled buttons on the page), not a real affordance — the findings-pane instance is the one and
 * only place the action itself lives; the document column shows the heading alone.
 */

import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/feedback/empty-state";
import { RetryAfterNotice } from "@/components/feedback/retry-after-notice";
import { canonicalErrorMessage } from "@/lib/copy/errors";
import { ApiError } from "@/lib/api";
import type { DocumentOutput } from "@/shared/contracts/documents";
import {
  NOT_ANALYZED_HEADING,
  ANALYSE_NOW_LABEL,
  EXTRACTION_FAILED_HEADING,
  UPLOAD_AGAIN_LABEL,
  SAMPLE_UNANALYZABLE_HEADING,
  TOO_LONG_HEADING,
} from "../copy";

export interface NotReadyPanelProps {
  document: DocumentOutput;
  tooLong: boolean;
  onAnalyse: () => void;
  isAnalysing: boolean;
  showAction?: boolean;
  error?: ApiError | null;
}

function AnalyzeError({ error }: { error: ApiError }) {
  if (error.code === "RATE_LIMITED" || error.code === "UPSTREAM_UNAVAILABLE") {
    return <RetryAfterNotice kind={error.code} retryAfterSeconds={error.retryAfterSeconds} />;
  }
  return <p className="text-sm text-muted-foreground">{canonicalErrorMessage(error.code)}</p>;
}

export function NotReadyPanel({ document, tooLong, onAnalyse, isAnalysing, showAction = true, error }: NotReadyPanelProps) {
  const router = useRouter();

  if (tooLong) {
    return <EmptyState heading={TOO_LONG_HEADING} />;
  }

  // Defensive-only: samples are always opened pre-analyzed, so this should be unreachable.
  if (document.sampleId !== null) {
    return <EmptyState heading={SAMPLE_UNANALYZABLE_HEADING} />;
  }

  if (document.processingStatus === "extraction_failed") {
    // "Upload again" is a real navigation, never a retry of this same row's own analyze call —
    // POST .../analyze throws EXTRACTION_FAILED every time on this row.
    return <EmptyState heading={EXTRACTION_FAILED_HEADING} action={showAction ? { label: UPLOAD_AGAIN_LABEL, onClick: () => router.push("/chat") } : undefined} />;
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <EmptyState
        heading={NOT_ANALYZED_HEADING}
        action={showAction ? { label: isAnalysing ? "Analysing…" : ANALYSE_NOW_LABEL, onClick: onAnalyse } : undefined}
      />
      {showAction && error && <AnalyzeError error={error} />}
    </div>
  );
}
