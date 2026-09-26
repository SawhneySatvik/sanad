/**
 * Every fixed workspace string not already owned by a shared table (the error-copy table lives in
 * src/lib/copy/errors.ts; ScannedNotice/VerificationBadge own their own copy). Indian/
 * British English throughout ("Analyse", "Analysing"); API paths keep "analyze".
 */

export const NOT_ANALYZED_HEADING = "This document hasn't been analysed yet";
export const ANALYSE_NOW_LABEL = "Analyse now";
export const ANALYSING_LABEL = "Analysing…";

export const EXTRACTION_FAILED_HEADING = "We couldn't read this document.";
export const UPLOAD_AGAIN_LABEL = "Upload again";

export const SAMPLE_UNANALYZABLE_HEADING = "This sample couldn't be analysed automatically. Please try opening it again.";

export const TOO_LONG_HEADING = "This document is too long for Saboot to analyse in one pass. Splitting or shortening it would help.";

export const EMPTY_FINDINGS_HEADING = "Saboot didn't find anything to flag in this document.";

export const GENERIC_DOCUMENT_NOTICE =
  "This doesn't look like one of the five document types Saboot knows well. The analysis is general.";

export const SAMPLE_NOTICE =
  "Sample document. Its analysis was recorded earlier and is re-checked against the text every time you open it.";

export const DOCUMENT_TEXT_LABEL = "Document text";
export const BACK_TO_FINDING_LABEL = "Back to finding";

export const VIEWING_AS_LABEL = "Viewing as";

export const PREPARE_LABEL = "Prepare";
export const COMPARE_LABEL = "Compare";
export const DRAFT_REPLY_LABEL = "Draft a reply";

export const SHOW_IN_DOCUMENT_LABEL = "Show in document";
export const TEST_THIS_QUOTE_LABEL = "Test this quote";
export const CHECKLIST_CAPTION = "No matching clause found in your document.";

export const CONTINUE_IN_CHAT_LABEL = "Continue in chat";
export const FINDINGS_SEGMENT_LABEL = "Findings";
export const ASK_SEGMENT_LABEL = "Ask";

export const ASK_COMPOSER_PLACEHOLDER = "Ask about this document…";
export const ASK_EMPTY_PROMPT = "Ask a question about this document.";

export const VERIFIER_CHECKING_LABEL = "Checking…";
export const VERIFIER_DONE_LABEL = "Done";
export const VERIFIER_TOO_LONG_MESSAGE = "That's too long to check — keep it under 4,000 characters.";

export const ASK_STREAM_ERROR_MESSAGE = "Something interrupted that answer.";
export const ASK_RETRY_LABEL = "Retry";

export const SAVE_TO_PROJECT_LABEL = "Save to project";

export function jumpAnnouncement(categoryLabel: string): string {
  return `Showing this ${categoryLabel.toLowerCase()} in the document.`;
}
