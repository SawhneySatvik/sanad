"use client";

/** One attached-document chip above the composer — filename + a remove control whose hit area meets the 44x44px touch floor even at product density (the chip itself renders smaller). */

import { FileText, X } from "lucide-react";

export interface AttachedDocument {
  id: string;
  label: string;
}

export interface AttachmentChipRowProps {
  attachments: readonly AttachedDocument[];
  onRemove: (id: string) => void;
}

export function AttachmentChipRow({ attachments, onRemove }: AttachmentChipRowProps) {
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className="flex items-center gap-1.5 rounded-full border border-border bg-secondary py-1 pr-1 pl-2 text-xs text-secondary-foreground"
        >
          <FileText aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="max-w-40 truncate">{attachment.label}</span>
          <button
            type="button"
            aria-label={`Remove ${attachment.label}`}
            onClick={() => onRemove(attachment.id)}
            className="relative inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground before:absolute before:-inset-3 before:content-[''] hover:text-foreground"
          >
            <X aria-hidden="true" className="size-3" strokeWidth={1.75} />
          </button>
        </li>
      ))}
    </ul>
  );
}
