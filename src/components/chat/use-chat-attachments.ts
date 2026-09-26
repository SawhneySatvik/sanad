"use client";

/**
 * Attachment state for both /chat (a fresh ?attach= deep link) and a reopened local thread (whose
 * documentIds resolve to labels one fetchDocument call each). Kept as one hook because both paths
 * write into the same `attachments` state and the same local-thread persistence — splitting them
 * further would only recreate the coordination this hook exists to own.
 */

import { useEffect, useRef, useState } from "react";
import { MAX_CONTEXT_DOCUMENTS } from "@/shared/contracts/threads";
import type { DocumentWithFindingsOutput } from "@/shared/contracts/documents";
import { loadLocalThread, saveLocalThread } from "@/lib/guest-threads";
import type { GuestThread } from "@/lib/guest-thread-store";
import { fetchDocument } from "./api";

/** The chip label an attachment falls back to when its own GET /api/documents/:id fails (an expired guest document, most often) — the id is still known and still attached, so the chip stays removable even without a real title. */
const NEUTRAL_ATTACHMENT_LABEL = "Attached document";

export interface AttachedDoc {
  id: string;
  label: string;
}

function toAttachedDoc(document: DocumentWithFindingsOutput): AttachedDoc {
  return { id: document.document.id, label: document.document.title || document.document.filename };
}

export interface UseChatAttachmentsOptions {
  /** null for /chat (home); a local-<uuid> or a real server thread id for /chat/[chatId] — read once, the ?attach= deep link's own mount gate. */
  chatId: string | null;
  /** The active local thread's own id, or null once it's a real server thread — persists an add/remove into that thread's documentIds. */
  localId: string | null;
  /** A reopened local thread's own snapshot, for resolving each of its documentIds to a label. */
  thread: GuestThread | null;
  signInAvailable: boolean;
}

export interface UseChatAttachments {
  attachments: AttachedDoc[];
  attachFailedNotice: boolean;
  secondUploadNudge: boolean;
  handleAttached: (documentId: string) => void;
  handleRemoveAttachment: (id: string) => void;
  /** The pathname-reset effect's own concern, on a genuine navigation back to /chat. */
  reset: () => void;
}

export function useChatAttachments({ chatId, localId, thread, signInAvailable }: UseChatAttachmentsOptions): UseChatAttachments {
  const [attachments, setAttachments] = useState<AttachedDoc[]>([]);
  const [attachFailedNotice, setAttachFailedNotice] = useState(false);
  const [secondUploadNudge, setSecondUploadNudge] = useState(false);
  const [, setUploadCount] = useState(0);
  const attachHandledRef = useRef(false);

  // Attachment labels for a reopened local thread's own documentIds — the snapshot carries only
  // ids; each one resolves through its own bare fetchDocument call below, straight into this
  // component's local `attachments` state (never a shared query cache).
  useEffect(() => {
    if (!thread) return;
    for (const documentId of thread.documentIds) {
      void fetchDocument(documentId)
        .then((document) => {
          setAttachments((prev) => (prev.some((a) => a.id === documentId) ? prev : [...prev, toAttachedDoc(document)]));
        })
        .catch(() => {
          // An expired/foreign guest document — still attached, still removable, just without a real title.
          setAttachments((prev) => (prev.some((a) => a.id === documentId) ? prev : [...prev, { id: documentId, label: NEUTRAL_ATTACHMENT_LABEL }]));
        });
    }
  }, [thread]);

  // ?attach=<documentId>: read once, cleared via replaceState either way. Only meaningful on a
  // fresh /chat home mount (chatId prop null) — the one place this param is produced.
  useEffect(() => {
    if (chatId !== null || attachHandledRef.current) return;
    attachHandledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const documentId = params.get("attach");
    if (!documentId) return;

    void fetchDocument(documentId)
      .then((document) => {
        if (document.document.processingStatus !== "ready") {
          setAttachFailedNotice(true);
          return;
        }
        setAttachments((prev) => (prev.length >= MAX_CONTEXT_DOCUMENTS ? prev : [...prev, toAttachedDoc(document)]));
      })
      .catch(() => setAttachFailedNotice(true))
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("attach");
        window.history.replaceState(null, "", url.pathname + url.search);
      });
  }, [chatId]);

  function addAttachment(documentId: string, doc: AttachedDoc): void {
    setAttachments((prev) => (prev.length >= MAX_CONTEXT_DOCUMENTS ? prev : [...prev, doc]));
    if (localId) saveLocalThread(localId, { ...loadLocalThread(localId), documentIds: [...loadLocalThread(localId).documentIds, documentId] });
    setUploadCount((prev) => {
      const next = prev + 1;
      if (next === 2 && signInAvailable) setSecondUploadNudge(true);
      return next;
    });
  }

  function handleAttached(documentId: string): void {
    void fetchDocument(documentId)
      .then((document) => addAttachment(documentId, toAttachedDoc(document)))
      .catch(() => addAttachment(documentId, { id: documentId, label: NEUTRAL_ATTACHMENT_LABEL }));
  }

  function handleRemoveAttachment(id: string): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    if (localId) {
      const thread = loadLocalThread(localId);
      saveLocalThread(localId, { ...thread, documentIds: thread.documentIds.filter((d) => d !== id) });
    }
  }

  function reset(): void {
    setAttachments([]);
    setAttachFailedNotice(false);
    setSecondUploadNudge(false);
    setUploadCount(0);
    attachHandledRef.current = false;
  }

  return { attachments, attachFailedNotice, secondUploadNudge, handleAttached, handleRemoveAttachment, reset };
}
