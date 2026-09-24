/**
 * GET /api/documents/:id/text. The one response the contract lint allows to carry canonical text:
 * `text` is the document's own canonical_text, byte-exact — never sanitizeModelText()'d, since
 * bindSpan()'s `text.slice(spanStart, spanEnd) === spanText` check depends on it matching what
 * verify() ran against. `inputMode` labels a native_document's text as a transcription, not
 * independent evidence; it is never dismissible. `sampleId` lets the client show the persistent
 * sample notice without a second round trip.
 */

import { z } from "zod";
import { INPUT_MODES } from "./vocabulary";

export const DocumentTextOutput = z.object({
  documentId: z.guid(),
  text: z.string(),
  textHash: z.string(),
  inputMode: z.enum(INPUT_MODES),
  sampleId: z.string().nullable(),
});
export type DocumentTextOutput = z.infer<typeof DocumentTextOutput>;
