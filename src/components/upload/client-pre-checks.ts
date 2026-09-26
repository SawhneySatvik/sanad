/**
 * The fast, friendly first pass, run before any request fires. A file that passes every check here
 * can still fail server-side — this is never the only enforcement, only a cheaper, kinder one for
 * the cases the client can decide on its own. Checked in order: empty, then too-large, then type,
 * then filename length.
 */

import { ALLOWED_MIME_TYPES, MAX_FILENAME_CHARS, MAX_UPLOAD_SIZE_BYTES, MIME_BY_EXTENSION, type AllowedMimeType } from "./constants";
import { FILENAME_TOO_LONG_MESSAGE, REASON_COPY, type UploadErrorReason } from "./copy";

export type ClientPreCheckReason = Extract<UploadErrorReason, "empty" | "too_large" | "unsupported_type"> | "filename_too_long";

export type ClientPreCheckResult =
  | { ok: true; mimeType: AllowedMimeType }
  | { ok: false; reason: ClientPreCheckReason; message: string };

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Resolves a File's real mime type for the request, falling back to the filename's own extension
 * when the browser reports an empty File.type (a documented .docx/.txt browser quirk) — never
 * silently accepted, and never the cause of a false "unsupported type" rejection.
 */
function resolveMimeType(file: File): AllowedMimeType | null {
  if (file.type && isAllowedMimeType(file.type)) return file.type;
  if (file.type) return null; // a declared, disallowed type is unsupported regardless of extension
  const byExtension = MIME_BY_EXTENSION[extensionOf(file.name)];
  return byExtension ?? null;
}

export function runClientPreChecks(file: File): ClientPreCheckResult {
  if (file.size === 0) {
    return { ok: false, reason: "empty", message: REASON_COPY.empty! };
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return { ok: false, reason: "too_large", message: REASON_COPY.too_large! };
  }
  const mimeType = resolveMimeType(file);
  if (!mimeType) {
    return { ok: false, reason: "unsupported_type", message: REASON_COPY.unsupported_type! };
  }
  if (file.name.length > MAX_FILENAME_CHARS) {
    return { ok: false, reason: "filename_too_long", message: FILENAME_TOO_LONG_MESSAGE };
  }
  return { ok: true, mimeType };
}
