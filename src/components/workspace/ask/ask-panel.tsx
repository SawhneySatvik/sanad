"use client";

/**
 * The Ask segment's body: the message log, "Continue in chat," and a mid-stream error's manual
 * Retry — never the composer itself, which is shared across the Findings/Ask segments and pinned
 * once by the caller (desktop: DocumentHeader's sibling segmented control; phone: base view or the
 * sheet's active tab, depending on which one is open).
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MessageList } from "./message-list";
import type { UseAskConversationResult } from "./use-ask-conversation";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import { CONTINUE_IN_CHAT_LABEL, ASK_STREAM_ERROR_MESSAGE, ASK_RETRY_LABEL } from "../copy";

export interface AskPanelProps {
  conversation: UseAskConversationResult;
  documentId: string;
  documentLabel: string;
  onCitationClick: (citation: AskCitationOutput) => void;
  alwaysPresentLog?: boolean;
}

export function AskPanel({ conversation, documentId, documentLabel, onCitationClick, alwaysPresentLog }: AskPanelProps) {
  const { turns, streamingText, status, errorMessage, retry } = conversation;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {turns.length > 0 && (
        <div className="flex items-center justify-end border-b border-border px-3 py-1.5">
          <Link
            href={`/chat?attach=${encodeURIComponent(documentId)}`}
            prefetch={false}
            className="relative inline-flex min-h-[44px] items-center text-sm font-medium text-primary before:absolute before:-inset-1 before:content-[''] hover:underline"
          >
            {CONTINUE_IN_CHAT_LABEL}
          </Link>
        </div>
      )}
      <MessageList turns={turns} streamingText={streamingText} documentLabel={documentLabel} onCitationClick={onCitationClick} alwaysPresent={alwaysPresentLog} />
      {status === "error" && (
        <div className="flex items-center justify-between gap-2 border-t border-border p-3 text-sm">
          <p className="text-foreground">{errorMessage ?? ASK_STREAM_ERROR_MESSAGE}</p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {ASK_RETRY_LABEL}
          </Button>
        </div>
      )}
    </div>
  );
}
