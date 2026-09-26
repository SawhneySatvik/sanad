import { House, Briefcase, Lock, Shield, Handshake, PenLine, type LucideIcon } from "lucide-react";

/**
 * A client-safe mirror of the server's DOCUMENT_TYPE_REGISTRY labels/icons — never imported from
 * src/server (that would pull server-only code into the browser bundle). A parity test keeps
 * DRAFTABLE_TYPES equal to the registry's own id/label pairs for the five draftable ids.
 *
 * Draft's own composer needs an icon per type (DRAFTABLE_TYPES/fromScratchTypeLabel); the library
 * table needs a flat label lookup across every kind a row can be, including the two ids with no
 * from-scratch meaning of their own (`grounded_response`, `generic`) — documentTypeLabel covers
 * that broader set without forcing the composer's icon-bearing shape to carry rows it never renders.
 */
export const DRAFTABLE_TYPES = [
  { id: "leave_and_license", label: "Leave and License Agreement (Rental)", Icon: House },
  { id: "job_offer_letter", label: "Job Offer Letter", Icon: Briefcase },
  { id: "nda", label: "Non-Disclosure Agreement", Icon: Lock },
  { id: "privacy_policy", label: "Privacy Policy", Icon: Shield },
  { id: "freelance_service_agreement", label: "Freelance Service Agreement", Icon: Handshake },
] as const satisfies readonly { id: string; label: string; Icon: LucideIcon }[];

export type FromScratchDocumentTypeId = (typeof DRAFTABLE_TYPES)[number]["id"];

export const GROUNDED_RESPONSE_LABEL = "Grounded Response Draft";
export const GROUNDED_RESPONSE_ICON = PenLine;
const GENERIC_DOCUMENT_LABEL = "Generic document";

export function fromScratchTypeLabel(documentType: string): string {
  return DRAFTABLE_TYPES.find((entry) => entry.id === documentType)?.label ?? documentType;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  ...Object.fromEntries(DRAFTABLE_TYPES.map((entry) => [entry.id, entry.label])),
  grounded_response: GROUNDED_RESPONSE_LABEL,
  generic: GENERIC_DOCUMENT_LABEL,
};

/** The library table's Type column — every documentType a row can carry, not only the draftable five. */
export function documentTypeLabel(documentType: string | null): string {
  if (!documentType) return GENERIC_DOCUMENT_LABEL;
  return DOCUMENT_TYPE_LABELS[documentType] ?? documentType;
}

const DRAFT_MODE_LABELS: Record<"from_scratch" | "document_grounded", string> = {
  from_scratch: "From scratch",
  document_grounded: "Grounded",
};

export function draftModeLabel(mode: "from_scratch" | "document_grounded"): string {
  return DRAFT_MODE_LABELS[mode];
}
