/**
 * draftService's DraftResult -> the drafts contract's wire shape. A pure mapper: the import of the
 * service's own shape is `import type`, erased at compile time, never a runtime dependency.
 * Explicit field whitelist, not a spread — a draft's wire shape must never carry a status/verified
 * key, and a field added to DraftResult later reaches the wire only once this mapper names it.
 */

import type { DraftResult, DraftSectionOutput } from "@/server/services/draft";
import { sanitizeModelText } from "@/server/deterministic/sanitize/model-text";
import { renderDraftContent } from "@/server/deterministic/draft-templates";

/** Maps a DraftResult to the wire shape. */
export function draftView(result: DraftResult) {
  const sections = result.sections.map(sectionView);
  return {
    id: result.id,
    title: result.title,
    documentType: result.documentType,
    mode: result.mode,
    groundingDocumentId: result.groundingDocumentId,
    revisionNumber: result.revisionNumber,
    parentDraftId: result.parentDraftId,
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
    modelUsed: result.modelUsed,
    jurisdiction: result.jurisdiction,
    groundingDocumentAvailable: result.groundingDocumentAvailable,
    promptVersion: result.promptVersion,
    content: renderDraftContent(result.documentType, sections.map((section) => ({ sectionKey: section.key, content: section.content }))),
    sections,
  };
}

function sectionView(section: DraftSectionOutput) {
  return { key: section.key, heading: section.heading, provenance: section.provenance, content: section.provenance === "ai_generated" ? sanitizeModelText(section.content) : section.content };
}
