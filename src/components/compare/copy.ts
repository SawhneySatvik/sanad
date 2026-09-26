/**
 * Every fixed Compare string not already owned by a shared table (src/lib/copy/errors.ts owns the
 * error-copy table; VerificationBadge/ScannedNotice own their own copy).
 */

export const PICKER_HEADING = "Compare documents";
export const PICKER_BODY = "Upload two versions of a document to compare them.";
export const SLOT_A_LABEL = "Document A";
export const SLOT_B_LABEL = "Document B";
export const CHOOSE_DOCUMENT_LABEL = "Choose a document";
export const SWAP_LABEL = "Swap Document A and Document B";
export const REMOVE_LABEL = "Remove";
export const COMPARE_ACTION_LABEL = "Compare";
export const TRY_AGAIN_LABEL = "Try again";
export const DEEP_LINK_FAILED_NOTICE = "That document couldn't be added to Compare.";
export const STILL_PROCESSING_NOTE = "Still processing";
export const COULD_NOT_BE_READ_NOTE = "Couldn't be read";
export const EMPTY_LIBRARY_HEADING = "No documents yet.";
export const ADD_A_DOCUMENT_LABEL = "Go to chat to add a document";

export const SUMMARY_BAR_LABEL = "Summary of changes";
export const NO_CHANGES_TRIGGER_LABEL = "No changes found";
export const NO_CHANGES_BODY = "These two documents matched exactly — nothing needed explaining.";
export const SHOW_THIS_CHANGE_LABEL = "Show this change";
export const OPEN_IN_DOCUMENT_LABEL = "Open in document";
export const BACK_TO_CHANGES_LABEL = "Back to changes";
export const SPAN_NOT_LOCATED_ANNOUNCEMENT = "This quote couldn't be located in the document text.";

export const CHANGE_TYPE_LABELS: Record<"added" | "removed" | "changed", string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};

export function notPresentLabel(side: "A" | "B"): string {
  return `Not present in Document ${side}.`;
}

export const COULD_NOT_RECHECK_LABEL = "Couldn't be re-checked against this document right now.";

export function sideJumpAnnouncement(side: "A" | "B"): string {
  return `Showing this change in Document ${side}.`;
}

export function paneLabel(side: "A" | "B", title: string): string {
  return `Document ${side}: ${title}`;
}

export const TABS_A_LABEL = "Document A";
export const TABS_B_LABEL = "Document B";
export const TAB_CHANGES_LABEL = "Changes";
