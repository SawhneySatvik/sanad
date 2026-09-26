/**
 * One assistant turn. Grounded shows citations plus AiLabel/ModelUsedNote; general
 * shows the fixed GENERAL_MODE_LABEL via AiLabel and NEVER a citation. ModelUsedNote omits itself
 * for a redirect answer (modelUsed is the literal "none" — showing "Answered by none" would be
 * false, since no model ran).
 */

import { AiLabel } from "@/components/verification/ai-label";
import { ModelUsedNote } from "@/components/verification/model-used-note";
import { GENERAL_MODE_LABEL } from "@/shared/contracts/threads";
import { CitationList } from "./citation-list";
import type { DisplayMessage } from "./types";

export interface AssistantMessageProps {
  message: DisplayMessage;
}

export function AssistantMessage({ message }: AssistantMessageProps) {
  const isRedirectGeneral = message.mode === "general" && message.redirect && message.modelUsed === "none";

  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="sr-only">Saboot said</span>
      <p className="max-w-[85%] rounded-2xl bg-card px-3 py-2 text-sm whitespace-pre-wrap text-card-foreground ring-1 ring-foreground/10">
        {message.content}
      </p>

      {message.mode === "grounded" && <CitationList citations={message.citations} />}

      <div className="flex flex-wrap items-center gap-2">
        {message.mode === "general" ? <AiLabel generalModeLabel={GENERAL_MODE_LABEL} /> : <AiLabel provenance="ai_generated" />}
        {!isRedirectGeneral && message.modelUsed && <ModelUsedNote modelUsed={message.modelUsed} />}
      </div>
    </div>
  );
}
