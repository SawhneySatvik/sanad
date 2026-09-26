// Every fixed Prepare string not already owned by a shared table (lens labels live in
// src/shared/lens-labels.ts; the not-legal-advice/AI-generated notice lives in
// src/shared/copy/legal-advice.ts; ScannedNotice/VerificationBadge own their own copy).

export const BACK_TO_DOCUMENT_LABEL = "Back to document";
export const VIEWING_AS_LABEL = "Viewing as";
export const LENS_CHANGE_NOTE = "Changing this writes a new set of questions.";

export const QUESTIONS_HEADING = "Questions to ask your lawyer";
export const CHECKLIST_HEADING = "Before you sign / before you meet your lawyer";

// Mirrors src/server/deterministic/prepare-export/markdown.ts's own AI_GENERATED_NOTICE constant —
// that file keeps it private (not exported from LEGAL_ADVICE_COPY, unlike the not-legal-advice
// line), so this is a second, independent copy of the same fixed sentence rather than a shared
// import, the same duplication accepted below for GENERIC_DOCUMENT_NOTICE.
export const AI_GENERATED_NOTICE =
  "The questions and checklist below are AI-generated general information, not verified statements. Only the quoted passage under each one has been checked against your document — the question, explanation and checklist text itself is not verified.";

export const PREPARING_LABEL = "Preparing your questions…";
export const PREPARE_READY_ANNOUNCEMENT = "Your questions and checklist are ready.";

export const MISSING_CLAUSE_CITATION_LABEL = "Flagged as possibly missing";

// Same fixed wording as the analysis workspace's own generic-document callout — repeated here
// rather than imported, since the two screens' notices are independent UI surfaces that happen to
// need identical copy, not one shared control.
export const GENERIC_DOCUMENT_NOTICE =
  "This doesn't look like one of the five document types Saboot knows well. The analysis is general.";

export const NOT_ANALYZED_HEADING = "This document hasn't been analysed yet.";
export const NOT_ANALYZED_BODY = "Prepare needs a finished analysis to work from.";

export const EXTRACTION_FAILED_HEADING = "We couldn't read this document.";
export const EXTRACTION_FAILED_BODY = "Saboot couldn't extract any text from this file, so there's nothing to prepare from. Try uploading it again.";

export const NO_GROUNDED_FINDINGS_HEADING = "There's nothing verified enough in this document yet to prepare from.";
export const NO_GROUNDED_FINDINGS_BODY =
  "Every finding in this document is either unverified or a flagged gap — Prepare only builds on findings it can show you the exact words for.";

export const GO_TO_DOCUMENT_LABEL = "Go to document";

// generate() throws INVALID_DOCUMENT with a developer-facing message describing the exact character
// counts — this is the reader-facing copy instead, since the document's own size never changes and
// no retry is offered.
export const TOO_LONG_TO_PREPARE_MESSAGE = "This document has too much verified text for Saboot to prepare from in one pass.";

export function preparedForHeading(label: string): string {
  return `Prepared for: ${label}`;
}
