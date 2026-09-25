/** Upload policy shared by every StorageAdapter implementation — adapter-agnostic, so a future Supabase adapter reuses it too. */

import { AppError } from "../core/errors";
import { MAX_INPUT_BYTES } from "../deterministic/extract";
import type { CreateUploadTargetInput } from "./types";

/** MIME types an upload may declare. */
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/plain",
] as const;

/** One of ALLOWED_MIME_TYPES. */
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/**
 * Reused from extract's own cap, not duplicated, so the two can never silently drift apart —
 * extract owns the actual number. `extract()` re-checks this same constant against the bytes it
 * reads via the storage ref; this is a pre-storage gate, not a replacement for that check.
 */
export const MAX_UPLOAD_SIZE_BYTES = MAX_INPUT_BYTES;

/**
 * An upload not confirmed within this long after its target was created is refused and swept.
 * Twice the relay URL's 15-minute lifetime (http/uploads.ts), so an upload that starts just before
 * its URL expires still has 15 minutes to be confirmed.
 */
export const UNCONFIRMED_UPLOAD_TTL_MS = 30 * 60 * 1000;

/** Longest filename kept for display, in code points. */
export const MAX_DISPLAY_FILENAME_CHARS = 200;

// Bidi controls, built from code points: embeddings and overrides, isolates, the implicit marks
// and the Arabic letter mark. Any one can make a filename display differently from what it says.
const BIDI_CONTROLS_RE = new RegExp(
  `[${[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("")}]`,
  "gu",
);

/**
 * A client-declared filename made safe to store and echo: control and bidi characters removed,
 * lone surrogates replaced, cut to MAX_DISPLAY_FILENAME_CHARS code points; "document" if nothing is
 * left. For display only — the storage ref sanitizes its own copy separately (refs.ts).
 */
export function displayFilename(filename: string): string {
  const cleaned = Array.from(filename.toWellFormed().replace(/\p{Cc}/gu, "").replace(BIDI_CONTROLS_RE, ""))
    .slice(0, MAX_DISPLAY_FILENAME_CHARS)
    .join("")
    .trim();
  return cleaned === "" ? "document" : cleaned;
}

function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Throws AppError("INVALID_DOCUMENT") — never a bare Error — so every caller can rely on the one typed error surface. */
export function assertUploadAllowed(metadata: CreateUploadTargetInput): void {
  if (!isAllowedMimeType(metadata.mimeType)) {
    throw new AppError("INVALID_DOCUMENT", `Unsupported file type: ${metadata.mimeType}`, { reason: "unsupported_type" });
  }
  if (
    !Number.isInteger(metadata.sizeBytes) ||
    metadata.sizeBytes <= 0 ||
    metadata.sizeBytes > MAX_UPLOAD_SIZE_BYTES
  ) {
    // The contract's own `sizeBytes: z.number().int().positive()` already rejects a non-positive
    // declared size as 400 VALIDATION_FAILED before this runs — the only real branch left here is
    // "too large."
    throw new AppError(
      "INVALID_DOCUMENT",
      `File size ${metadata.sizeBytes} bytes is outside the allowed 1-${MAX_UPLOAD_SIZE_BYTES} byte range.`,
      { reason: "too_large" },
    );
  }
}

/**
 * Same INVALID_DOCUMENT/too_large shape assertUploadAllowed uses, parameterized on a stricter cap —
 * reused by an adapter whose own ceiling sits below MAX_UPLOAD_SIZE_BYTES (postgres-adapter.ts's
 * Vercel relay-body-size cap), so the UI's error card never has to distinguish two "too large" reasons.
 */
export function assertSizeWithinCap(sizeBytes: number, capBytes: number, capLabel: string): void {
  if (sizeBytes > capBytes) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `File size ${sizeBytes} bytes exceeds ${capLabel}'s ${capBytes}-byte upload cap.`,
      { reason: "too_large" },
    );
  }
}

/**
 * Re-checked against the actual bytes at writeRelayed time — in server-relay mode the declared
 * sizeBytes at createUploadTarget came from the client and isn't itself trustworthy. This check runs
 * after the request body has already been fully buffered into `bytes: Uint8Array` — it bounds what
 * gets written to disk, but does nothing to bound memory/CPU spent buffering an oversized request.
 * The caller must cap the incoming request stream itself before or while buffering.
 */
export function assertWrittenSizeAllowed(actualSizeBytes: number): void {
  // Split by reason, not one combined check: the declared-size contract already rejects a
  // client-declared zero/negative size before this point, so a non-positive actual byte count here
  // is the real zero-byte-content case (empty), distinct from an over-cap one (too_large).
  if (actualSizeBytes <= 0) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `Uploaded object is ${actualSizeBytes} bytes, outside the allowed 1-${MAX_UPLOAD_SIZE_BYTES} byte range.`,
      { reason: "empty" },
    );
  }
  if (actualSizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `Uploaded object is ${actualSizeBytes} bytes, outside the allowed 1-${MAX_UPLOAD_SIZE_BYTES} byte range.`,
      { reason: "too_large" },
    );
  }
}
