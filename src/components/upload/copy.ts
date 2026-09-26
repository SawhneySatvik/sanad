/**
 * Every fixed upload-flow string, in one place — never restated inline, so a copy change never has
 * to be found twice. The reason table is an exhaustive Record over the full shared ERROR_REASONS
 * union (a compile error catches a new reason silently missing a row, the same technique
 * src/lib/copy/errors.ts uses for codes) — `null` marks a reason this screen has no bespoke copy
 * for, which falls back to the per-code fixed message instead.
 */

import { ERROR_REASONS } from "@/shared/contracts/vocabulary";
import { MAX_UPLOAD_SIZE_BYTES } from "./constants";

export type UploadErrorReason = (typeof ERROR_REASONS)[number];

// This file's own zero-byte/too-large/unsupported-type copy is reused verbatim for the client
// pre-checks, so a client-caught rejection and a server-caught one never disagree with each other.
export const REASON_COPY: Record<UploadErrorReason, string | null> = {
  empty: "This file is empty.",
  too_large: `This file is too large. Saboot accepts files up to ${Math.round(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB.`,
  unsupported_type: "Saboot can't read this file type. Upload a PDF, DOCX, or plain-text file.",
  type_mismatch: "This file's contents don't match the type it was sent as. Re-save it and try again.",
  unreadable: "Saboot couldn't read this file. It may be corrupted — try re-exporting or re-scanning it.",
  // Not part of this screen's own spec (they belong to Ask/Draft/Compare and the retry-analyze
  // route) — no bespoke upload copy exists for them, so they fall back to the per-code message.
  document_not_ready: null,
  grounding_not_ready: null,
  grounding_too_long: null,
  sample_readonly: null,
};

export const FILENAME_TOO_LONG_MESSAGE = "That filename is too long. Rename the file and try again.";

export const UPLOAD_INTERRUPTED_MESSAGE = "The upload was interrupted. Please try again.";

export const PHASE_LABEL = {
  "requesting-target": "Preparing upload…",
  analyzing: "Reading the document…",
} as const;

export function guestRetentionNoticeText(guestTtlHours: number): string {
  return `Guest documents are deleted after about ${guestTtlHours} hours.`;
}

export const CHOOSE_ANOTHER_FILE_LABEL = "Choose another file";
export const RETRY_ANALYSIS_LABEL = "Retry analysis";
export const CANCEL_LABEL = "Cancel";

export const SIGN_IN_NUDGE_COPY = {
  save: "Sign in to keep this",
  second_upload: "Sign in to keep this",
  claim: "Sign in to keep this",
} as const;
