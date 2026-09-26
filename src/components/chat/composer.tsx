"use client";

/**
 * The pinned Ask input, plus the upload mount: the composer BOX itself is the one drop
 * target; the paperclip is either a live UploadDropzone or — once the thread is a real saved row,
 * which can never accept a fresh attachment — a focusable, aria-disabled control that always shows
 * its reason as plain visible text (never a silently-hidden affordance, and never gated on
 * hover/focus alone, which would re-announce the reason to a screen reader every time the pointer
 * passed over it). useUploadFlow is mounted here, so the upload card above the composer tracks its
 * phase directly.
 */

import { useEffect, useRef, type DragEvent, type KeyboardEvent } from "react";
import { Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { ErrorState } from "@/components/feedback/error-state";
import {
  UploadDropzone,
  UploadErrorCard,
  UploadProgress,
  UploadRetentionNotice,
  useUploadFlow,
  type UploadCardError,
} from "@/components/upload";
import { OFFLINE_MESSAGE } from "@/lib/copy/errors";
import { AttachmentChipRow, type AttachedDocument } from "./attachment-chip";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  attachments: readonly AttachedDocument[];
  onRemoveAttachment: (id: string) => void;
  onAttached: (documentId: string) => void;
  /** Set (non-null) once the thread is a real saved row — the paperclip disables with this reason, always shown, never silently hidden. */
  attachDisabledReason?: string | null;
  offline?: boolean;
  isSignedIn: boolean;
  guestTtlHours?: number;
  /** A pre-stream 422 composer error (document_not_ready / grounding_too_long) — the message stays typed, unsent. */
  inlineError?: string | null;
}

const PLACEHOLDER = "Ask about a lease, an offer letter, an NDA — or attach a document";

function DisabledPaperclip() {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Attach a document"
      aria-disabled="true"
      aria-describedby="composer-attach-disabled-reason"
      onClick={(event) => event.preventDefault()}
      className="relative shrink-0 before:absolute before:-inset-2 before:content-['']"
    >
      <Paperclip aria-hidden="true" />
    </Button>
  );
}

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  attachments,
  onRemoveAttachment,
  onAttached,
  attachDisabledReason,
  offline,
  isSignedIn,
  guestTtlHours,
  inlineError,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const flow = useUploadFlow({ onUploaded: onAttached });

  // Focus lands on the composer once per fresh mount — both chat home's own greeting-screen mount
  // and the thread screen's first mount (this component isn't remounted again by a later message
  // in the same conversation, so this never steals focus back mid-thread).
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Once an upload lands, return the composer to idle immediately — the persistent record of the
  // attach is the (host-rendered) attachment chip row above, not this transient upload card.
  useEffect(() => {
    if (flow.phase === "done") flow.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flow.reset/flow.phase change identity every render; only the phase transition matters here.
  }, [flow.phase]);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (attachDisabledReason || offline) return;
    // UploadDropzone's own onDrop already ran and called preventDefault — bail here so the same
    // file isn't started twice when the drop also bubbles to this wrapper.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) flow.start(file);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (value.trim().length > 0 && !disabled) onSubmit();
    }
  }

  return (
    <div className="flex flex-col gap-2" onDragOver={(e) => !attachDisabledReason && !offline && e.preventDefault()} onDrop={handleDrop}>
      {!isSignedIn && <UploadRetentionNotice isSignedIn={isSignedIn} guestTtlHours={guestTtlHours} />}

      {flow.phase === "requesting-target" && <p className="text-sm text-muted-foreground">Preparing upload…</p>}
      {flow.phase === "uploading" && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
          <div className="flex-1">
            <UploadProgress phase="uploading" percent={flow.percent} fileMeta={flow.fileMeta} />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={flow.cancel}>
            Cancel
          </Button>
        </div>
      )}
      {flow.phase === "confirming" && (
        <div className="rounded-lg border border-border bg-card p-3">
          <UploadProgress phase="analyzing" fileMeta={flow.fileMeta} />
        </div>
      )}
      {flow.phase === "error" &&
        flow.error &&
        (flow.error.code === "INTERNAL_ERROR" ? (
          <ErrorState code="INTERNAL_ERROR" correlationId={flow.error.correlationId} onRetry={flow.reset} />
        ) : (
          <UploadErrorCard error={flow.error as UploadCardError} onRetryAnalysis={flow.retry} onChooseAnotherFile={flow.reset} />
        ))}

      <AttachmentChipRow attachments={attachments} onRemove={onRemoveAttachment} />

      {inlineError && <p className="text-sm text-destructive">{inlineError}</p>}

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim().length > 0 && !disabled) onSubmit();
        }}
      >
        <label htmlFor="chat-composer-input" className="sr-only">
          Ask Saboot
        </label>
        {/* The text field, attach and Send share ONE bordered box, the field on top at full width and
            the two actions in a row beneath it. The ring lives on the box via focus-within, so it
            never doubles with the textarea's own; the textarea goes borderless and ring-less. */}
        <div className="flex flex-col rounded-lg border border-input bg-transparent p-1 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30">
          <Textarea
            id="chat-composer-input"
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? PLACEHOLDER}
            disabled={disabled || offline}
            rows={1}
            className="max-h-48 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 disabled:border-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          />
          <div className="flex items-center justify-between">
            {attachDisabledReason ? (
              <DisabledPaperclip />
            ) : (
              <UploadDropzone
                onFilesSelected={(files) => {
                  const file = files[0];
                  if (file) flow.start(file);
                }}
                disabled={flow.busy || offline}
                disabledReason={offline ? OFFLINE_MESSAGE : undefined}
              />
            )}
            <Button type="submit" size="icon" className="size-11 shrink-0" disabled={disabled || offline || value.trim().length === 0} aria-label="Send">
              <Send aria-hidden="true" />
            </Button>
          </div>
        </div>
        {/* Always visible, not gated on hover/focus — a reason shown only on hover would announce
            itself again every time the pointer re-entered, and would hide the reason from anyone
            navigating by keyboard past the focus moment itself. Sits below the box, since it names
            the disabled paperclip, not the whole composer. */}
        {attachDisabledReason && (
          <InlineNotice tone="info">
            <span id="composer-attach-disabled-reason">{attachDisabledReason}</span>
          </InlineNotice>
        )}
      </form>
    </div>
  );
}
