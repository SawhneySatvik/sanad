/**
 * Mirrors src/server/storage/policy.ts's ALLOWED_MIME_TYPES/MAX_UPLOAD_SIZE_BYTES — duplicated,
 * not imported, because a client bundle must never pull in server code. Keep this in sync by hand;
 * a drift here only ever makes the client's pre-check stricter or looser than the server's real
 * enforcement, never unsafe, since the server re-checks everything itself — the client checks are a
 * fast, friendly first pass, never the only enforcement.
 */

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/plain",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

// 15 MiB (15 * 1024 * 1024), matching MAX_INPUT_BYTES/MAX_UPLOAD_SIZE_BYTES server-side — not the
// screens doc's literal "15_000_000", which is 15 MB decimal and would let through a file the
// server rejects. The code wins over the spec's literal number (CLAUDE.md).
export const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024;

// Matches CreateUploadTargetInput.filename's z.string().max(255) in src/shared/contracts/uploads.ts.
export const MAX_FILENAME_CHARS = 255;

// The <input type="file" accept="…"> attribute: extensions plus MIME types, since a browser's own
// file-type filter honours whichever form it recognises for a given OS/picker.
export const FILE_INPUT_ACCEPT = ".pdf,.docx,.txt," + ALLOWED_MIME_TYPES.join(",");

/** Extension -> mime, used only to resolve a blank File.type (a documented browser quirk). */
export const MIME_BY_EXTENSION: Record<string, AllowedMimeType> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

/** Human-readable accepted-types list for aria-describedby and error copy. */
export const ACCEPTED_TYPES_LABEL = "PDF, DOCX, or plain text";
