/**
 * `role="log"` joins the live-region allow-list only once it has something to log: on
 * desktop, once at least one turn exists (an empty Ask segment carries no log region yet); on
 * phone, per the same rule's own phone clause, for as long as the sheet's Ask tab is mounted at all
 * — `alwaysPresent` is how the phone host opts into that.
 */

import { EmptyState } from "@/components/feedback/empty-state";
import { UserMessage } from "./user-message";
import { AssistantMessage } from "./assistant-message";
import { StreamingPreview } from "./streaming-preview";
import type { AskTurn } from "./use-ask-conversation";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import { ASK_EMPTY_PROMPT } from "../copy";

export interface MessageListProps {
  turns: AskTurn[];
  streamingText: string | null;
  documentLabel: string;
  onCitationClick: (citation: AskCitationOutput) => void;
  /** True on the phone host, where the log region is present for as long as the Ask tab is mounted, not gated on message count. */
  alwaysPresent?: boolean;
}

export function MessageList({ turns, streamingText, documentLabel, onCitationClick, alwaysPresent = false }: MessageListProps) {
  const showLog = alwaysPresent || turns.length > 0;

  if (!showLog) {
    return <EmptyState heading={ASK_EMPTY_PROMPT} headingLevel={2} />;
  }

  return (
    <div role="log" aria-label="Conversation with Saboot about this document" className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {turns.map((turn) =>
        turn.role === "user" ? (
          <UserMessage key={turn.id} content={turn.content} />
        ) : (
          <AssistantMessage key={turn.id} message={turn} documentLabel={documentLabel} onCitationClick={onCitationClick} />
        ),
      )}
      {streamingText !== null && <StreamingPreview text={streamingText} />}
    </div>
  );
}
