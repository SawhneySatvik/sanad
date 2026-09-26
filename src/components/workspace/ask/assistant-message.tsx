import { useState } from "react";
import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";
import { CitationChip } from "@/components/verification/citation-chip";
import { AiLabel } from "@/components/verification/ai-label";
import { ModelUsedNote } from "@/components/verification/model-used-note";
import { verificationInfoCopy } from "../findings/verification-info-copy";
import type { AskCitationOutput, AskMessageOutput } from "@/shared/contracts/threads";

export interface AssistantMessageProps {
  message: AskMessageOutput;
  documentLabel: string;
  onCitationClick: (citation: AskCitationOutput) => void;
}

/**
 * A completed assistant turn: grounded (model text + citations) or general (the fixed
 * GENERAL_MODE_LABEL, never model text) — a real discriminated union the server decides, never
 * inferred client-side from `role`. CitationChip's own info button is a bare callback (the kit
 * component renders no content of its own) — this component owns showing the info text, exactly as
 * FindingCard's VerificationInfoButton does for a finding's badge.
 */
export function AssistantMessage({ message, documentLabel, onCitationClick }: AssistantMessageProps) {
  const [openInfoIndex, setOpenInfoIndex] = useState<number | null>(null);

  return (
    <div className="flex max-w-[90%] flex-col gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
      <p>
        <bdi style={BIDI_ISOLATE_STYLE}>{message.content}</bdi>
      </p>
      {message.mode === "grounded" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {message.citations.map((citation, index) => (
              <CitationChip
                key={citation.id ?? `citation-${index}`}
                citation={citation}
                documentLabel={documentLabel}
                onActivate={() => onCitationClick(citation)}
                onShowInfo={() => setOpenInfoIndex((prev) => (prev === index ? null : index))}
              />
            ))}
          </div>
          {openInfoIndex !== null && message.citations[openInfoIndex] && (
            <p className="text-xs text-muted-foreground">{verificationInfoCopy(message.citations[openInfoIndex].verification.status)}</p>
          )}
        </div>
      ) : (
        <AiLabel generalModeLabel={message.label} />
      )}
      <ModelUsedNote modelUsed={message.modelUsed} />
    </div>
  );
}
