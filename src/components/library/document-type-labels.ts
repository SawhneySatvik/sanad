/**
 * A local copy of the five draftable types' labels plus the two this screen also needs
 * (`grounded_response`, `generic`) — kept local rather than importing
 * `src/components/draft/document-type-labels.ts`'s copy, so this screen's Type/Analysis/Kind columns
 * don't depend on that file's own shape.
 */
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  leave_and_license: "Leave and License Agreement (Rental)",
  job_offer_letter: "Job Offer Letter",
  nda: "Non-Disclosure Agreement",
  privacy_policy: "Privacy Policy",
  freelance_service_agreement: "Freelance Service Agreement",
  grounded_response: "Grounded Response Draft",
  generic: "Generic document",
};

export function documentTypeLabel(documentType: string | null): string {
  if (!documentType) return "Generic document";
  return DOCUMENT_TYPE_LABELS[documentType] ?? documentType;
}

const DRAFT_MODE_LABELS: Record<"from_scratch" | "document_grounded", string> = {
  from_scratch: "From scratch",
  document_grounded: "Grounded",
};

export function draftModeLabel(mode: "from_scratch" | "document_grounded"): string {
  return DRAFT_MODE_LABELS[mode];
}
