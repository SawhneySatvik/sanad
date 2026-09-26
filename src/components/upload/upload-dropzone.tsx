"use client";

/**
 * The attach affordance + drop target — the caller places this wherever the composer's own drop
 * target box is; this component owns no opinion about page layout beyond its own bounding box.
 * Hands every selected file straight to onFilesSelected, unvalidated — useUploadFlow's start() runs
 * the real pre-checks against the one real cap (MAX_UPLOAD_SIZE_BYTES), so there is exactly one
 * place that decides accept/reject; this component has no size-cap prop of its own to disagree with
 * it, only the same fixed constant its own hint text quotes.
 */

import { useId, useRef, useState, type DragEvent } from "react";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACCEPTED_TYPES_LABEL, FILE_INPUT_ACCEPT, MAX_UPLOAD_SIZE_BYTES } from "./constants";
export { FILE_INPUT_ACCEPT } from "./constants";

export interface UploadDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  disabled?: boolean;
  /** Shown alongside the disabled control — a disabled affordance always names its reason, never a
   * silent hide. Rendered as plain visible text, never only inside the sr-only hint: a disabled
   * <button> can never take focus, so a reason reachable only via aria-describedby-on-focus would
   * never actually reach a screen-reader user. */
  disabledReason?: string;
  className?: string;
}

function sizeCapMb(): number {
  return Math.round(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024));
}

/** Drag-and-drop (desktop) + click-to-browse (both), always keyboard-reachable via a real <button>. */
export function UploadDropzone({ onFilesSelected, accept = FILE_INPUT_ACCEPT, disabled = false, disabledReason, className }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Unique per mount, not a fixed module-level string — two dropzones on the same page (or the same
  // one remounting) must never collide on the same DOM id.
  const describedById = useId();

  function selectFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    onFilesSelected(Array.from(fileList));
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (disabled) return;
    event.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    selectFiles(event.dataTransfer.files);
  }

  return (
    <div
      data-slot="upload-dropzone"
      data-dragover={dragOver ? "true" : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`rounded-lg transition-colors ${dragOver ? "outline outline-2 outline-offset-2 outline-ring" : ""} ${className ?? ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          selectFiles(event.target.files);
          // Lets choosing the same file twice in a row (e.g. after "Choose another file") still fire onChange.
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label="Attach a document"
        aria-describedby={describedById}
        onClick={() => inputRef.current?.click()}
        className="relative before:absolute before:-inset-2 before:content-['']"
      >
        <Paperclip aria-hidden="true" />
      </Button>
      <span id={describedById} className="sr-only">
        Accepts {ACCEPTED_TYPES_LABEL}, up to {sizeCapMb()} MB.
      </span>
      {/* Plain visible text, not sr-only: a disabled button never takes focus, so a reason living only
          inside the description above would never reach a screen-reader user tabbing past it. */}
      {disabled && disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
    </div>
  );
}
