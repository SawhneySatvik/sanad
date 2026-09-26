/**
 * Every fixed Draft-screen string, in one place — never restated inline or reworded per component.
 */

export const NEW_DRAFT_HEADING = "New draft";
export const FROM_SCRATCH_LABEL = "Start from scratch";
export const FROM_SCRATCH_DESCRIPTION = "Write a new document from a blank brief — no source document needed.";
export const DOCUMENT_GROUNDED_LABEL = "Respond to a document you have";
export const DOCUMENT_GROUNDED_DESCRIPTION = "Draft a reply grounded in one of your existing documents.";
export const DRAFT_ACTION_LABEL = "Draft";
export const REVISE_ACTION_LABEL = "Revise";

export const NO_DOCUMENTS_NOTE = "You don't have any documents yet. Upload one first, or start from scratch instead.";
export const GROUNDING_DEEP_LINK_FAILED_NOTICE = "That document couldn't be used to start a draft.";
export const GROUNDING_DOCUMENT_GONE_NOTICE = "The document this draft was based on is no longer available.";

export const CHARACTER_LIMIT_NOTE = "4000 character limit";
export const INSTRUCTIONS_MAX_LENGTH = 4000;

export const REVISE_NOTICE = "Revising creates a new revision. This one is kept.";
export const GO_TO_LATEST_LABEL = "Go to latest";
export const INSTRUCTIONS_NOT_RECORDED = "Instructions not recorded";

export function fromRevisionNote(revisionNumber: number): string {
  return `from revision ${revisionNumber}`;
}

export function basedOnLabel(title: string): string {
  return `Based on: ${title}`;
}

export function revisionLabel(revisionNumber: number): string {
  return `Revision ${revisionNumber}`;
}

// Type-specific guided-brief placeholders, one per from-scratch draftable type plus the grounded
// case — exact wording is a copywriting detail, not fixed anywhere else.
export const FROM_SCRATCH_PLACEHOLDER_BY_TYPE: Record<string, string> = {
  leave_and_license: "Describe the rental terms you want — rent, deposit, notice period, who the parties are…",
  job_offer_letter: "Describe the job offer terms you want — role, compensation, joining date, who the parties are…",
  nda: "Describe the confidentiality terms you want — what's confidential, who the parties are, how long it lasts…",
  privacy_policy: "Describe the privacy practices to cover — what data you collect, how it's used, who the parties are…",
  freelance_service_agreement: "Describe the freelance terms you want — scope, payment, timeline, who the parties are…",
};

export const GROUNDED_PLACEHOLDER = "Describe how you want to respond — what you're agreeing to, pushing back on, or asking for more time on…";

export const STILL_PROCESSING_NOTE = "Still processing";
export const COULD_NOT_BE_READ_NOTE = "Couldn't be read";

export const REVISIONS_TRIGGER_LABEL = (count: number) => `Revisions (${count})`;
