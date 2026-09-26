"use client";

/** The "Save this chat" flow: imports a reopened local thread's full history into a real, saved server thread. */

import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { useAnnounce } from "@/components/layout-primitives/live-region";
import { deleteLocalThreadAfterImport, loadLocalThread } from "@/lib/guest-threads";
import type { ThreadMessageOutput } from "@/shared/contracts/threads";
import { createThread } from "./api";

export const SAVE_TOO_LONG_MESSAGE =
  "This chat has grown too long to save as one conversation. Try saving from a more recent point, or start a new chat for further questions.";

export interface UseSaveThisChatOptions {
  /** The reopened local thread's own id, or null once there's nothing local left to save. */
  localId: string | null;
  isSignedIn: boolean;
  /** Everything ELSE a successful save changes — activeChatId, the URL, attachDisabledReason and pendingTurns all stay screen state, since a signed-in guest's very first turn (handleSubmit) sets them too. */
  onSaved: (savedId: string, messages: ThreadMessageOutput[]) => void;
}

export interface UseSaveThisChat {
  saveNudge: boolean;
  saving: boolean;
  handleSaveThisChat: () => Promise<void>;
  /** The pathname-reset effect's own concern, on a genuine navigation back to /chat. */
  reset: () => void;
}

export function useSaveThisChat({ localId, isSignedIn, onSaved }: UseSaveThisChatOptions): UseSaveThisChat {
  const announce = useAnnounce();
  const [saveNudge, setSaveNudge] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSaveThisChat(): Promise<void> {
    if (!localId) return;
    if (!isSignedIn) {
      setSaveNudge(true);
      return;
    }
    const thread = loadLocalThread(localId);
    setSaving(true);
    try {
      const importedMessages = thread.messages.map((message) => ({
        role: message.role,
        content: message.content,
        mode: message.mode,
        citations: message.citations.length
          ? message.citations.map((citation) => ({ quoteText: citation.quoteText, sourceDocumentId: citation.sourceDocumentId }))
          : undefined,
      }));
      const created = await createThread({
        title: thread.title,
        documentIds: thread.documentIds.length ? thread.documentIds : undefined,
        importedMessages,
      });
      deleteLocalThreadAfterImport(localId);
      onSaved(created.thread.id, created.messages);
      toast.success("Chat saved.");
      announce("Chat saved.", "polite");
    } catch (err) {
      if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
        toast.error(SAVE_TOO_LONG_MESSAGE);
      } else {
        toast.error("Couldn't save this chat.");
      }
    } finally {
      setSaving(false);
    }
  }

  function reset(): void {
    setSaveNudge(false);
    setSaving(false);
  }

  return { saveNudge, saving, handleSaveThisChat, reset };
}
