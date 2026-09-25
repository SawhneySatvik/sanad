/**
 * GET /api/documents/:id/text. The one route allowed to put canonical text on the wire:
 * getDocument is the same owner-checked repository read every other document route uses — no
 * special-cased access path exists here to bypass. A document that hasn't finished extraction has no
 * canonical_text yet, so it's INVALID_DOCUMENT/document_not_ready rather than a 200 standing in with
 * an empty string.
 */

import type { ServiceDeps } from "../container";
import { AppError } from "../core/errors";
import type { Principal } from "../core/types";
import { getDocument } from "../data/documents";

/** GET /api/documents/:id/text's result, mapped 1:1 onto DocumentTextOutput. */
export interface DocumentTextResult {
  documentId: string;
  text: string;
  textHash: string;
  inputMode: "text" | "native_document";
  sampleId: string | null;
}

export async function getText(deps: ServiceDeps, principal: Principal, documentId: string): Promise<DocumentTextResult> {
  const document = await getDocument(deps.db, principal, documentId);
  if (document.processingStatus !== "ready" || document.canonicalText === null || document.canonicalTextHash === null || document.inputMode === null) {
    throw new AppError("INVALID_DOCUMENT", "This document has not finished processing yet.", { reason: "document_not_ready" });
  }
  return {
    documentId: document.id,
    text: document.canonicalText,
    textHash: document.canonicalTextHash,
    inputMode: document.inputMode,
    sampleId: document.sampleId,
  };
}
