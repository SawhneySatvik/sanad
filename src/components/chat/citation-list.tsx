"use client";

/**
 * Renders one message's citations: a resolved citation (CitationChip, wired to VerificationBadge
 * through the kit — this file never draws its own badge) or a pending/failed one (PendingCitationChip,
 * which never composes VerificationBadge at all). A resolved citation whose source is scanned shows
 * ScannedNotice; a resolved not_found citation adds a fixed sentence naming the two possible causes
 * (a deleted/expired source or a genuine mismatch) without distinguishing which applied.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CitationChip } from "@/components/verification/citation-chip";
import { ScannedNotice } from "@/components/document/scanned-notice";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import { useDocumentLabel } from "./use-document-label";
import { PendingCitationChip } from "./pending-citation";
import type { DisplayCitation } from "./types";

const NOT_FOUND_EXTRA_SENTENCE = "The document may have been deleted or expired.";

const INFO_COPY: Record<AskCitationOutput["verification"]["status"], string> = {
  verified: "Found word for word in the document.",
  approximate: "Close to the document's wording, but not word for word.",
  not_found: "Could not be found in the document's text.",
};

function ResolvedCitation({ citation }: { citation: AskCitationOutput }) {
  const router = useRouter();
  const [showInfo, setShowInfo] = useState(false);
  const label = useDocumentLabel(citation.sourceDocumentId);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <CitationChip
        citation={citation}
        documentLabel={label}
        onActivate={() => {
          if (citation.sourceDocumentId) router.push(`/documents/${citation.sourceDocumentId}`);
        }}
        onShowInfo={() => setShowInfo((prev) => !prev)}
      />
      {showInfo && <p className="text-xs text-muted-foreground">{INFO_COPY[citation.verification.status]}</p>}
      {citation.inputMode === "native_document" && <ScannedNotice inputMode="native_document" />}
      {citation.verification.status === "not_found" && <p className="text-xs text-muted-foreground">{NOT_FOUND_EXTRA_SENTENCE}</p>}
    </span>
  );
}

export function CitationList({ citations }: { citations: readonly DisplayCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5">
      {citations.map((citation, index) => (
        <li key={index}>
          {citation.kind === "resolved" ? (
            <ResolvedCitation citation={citation.citation} />
          ) : (
            <PendingCitationChip
              preview={citation.preview}
              failed={citation.kind === "failed"}
              onRetry={citation.kind === "failed" ? citation.onRetry : undefined}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
