import { House, Briefcase, Lock, Shield, Handshake, PenLine, type LucideIcon } from "lucide-react";

/**
 * A client-safe mirror of the server's DOCUMENT_TYPE_REGISTRY labels/icons for the six draftable
 * ids — never imported from src/server (that would pull server-only code into the browser bundle).
 * A parity test keeps this list equal to the registry's own id/label pairs.
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

export function fromScratchTypeLabel(documentType: string): string {
  return DRAFTABLE_TYPES.find((entry) => entry.id === documentType)?.label ?? documentType;
}
