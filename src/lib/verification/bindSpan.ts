/**
 * The one place a span is bound to text anywhere in the client. Every consumer that wants to
 * highlight a quote in a document — HighlightMark/DocumentViewer, CitationChip's jump, a verifier
 * preview — goes through this single chokepoint instead of slicing `text` itself, so a forged,
 * stale or cross-document span can only ever be suppressed here, never rendered by a second,
 * independently-written binder.
 *
 * `expected.documentId` is checked even though `textHash` already is: two distinct documents can
 * share byte-identical text (and therefore an identical hash), so the hash alone cannot catch a
 * citation whose id points at the wrong document.
 */

import type { VerificationOutput } from "@/shared/contracts/common";
import type { DocumentTextOutput } from "@/shared/contracts/document-text";

export interface BoundRange {
  spanStart: number;
  spanEnd: number;
  spanText: string;
}

/** The target document's own already-fetched text — never a client-submitted string; canonical text is always extracted server-side from the document's own bytes. */
export type BindSpanTarget = Pick<DocumentTextOutput, "documentId" | "text" | "textHash">;

/** The citation/finding's own expected document id — the wrong-document check described above. */
export interface BindSpanExpected {
  documentId: string;
}

/**
 * Returns the bound range only if every one of these holds, otherwise null:
 * - the verification carries a span at all (not `not_found`);
 * - `expected.documentId` names the same document as `target`;
 * - `verification.textHash === target.textHash` (the stale-hash check);
 * - the span's offsets are in range and `target.text.slice(spanStart, spanEnd) === spanText`
 *   (the mismatched-slice check — this is also what stops a bogus `spanEnd` from slicing past
 *   `target.text`'s own length, which a plain `.slice()` would otherwise clamp silently).
 */
export function bindSpan(verification: VerificationOutput, target: BindSpanTarget, expected: BindSpanExpected): BoundRange | null {
  if (verification.status === "not_found") return null;
  if (expected.documentId !== target.documentId) return null;
  if (verification.textHash !== target.textHash) return null;

  const { spanStart, spanEnd, spanText } = verification;
  if (!Number.isInteger(spanStart) || !Number.isInteger(spanEnd)) return null;
  if (spanStart < 0 || spanEnd <= spanStart || spanEnd > target.text.length) return null;
  if (target.text.slice(spanStart, spanEnd) !== spanText) return null;

  return { spanStart, spanEnd, spanText };
}
