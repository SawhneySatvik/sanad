/**
 * Role x stage lenses: the 2-4 realistic reader perspectives per document type. One analysis call
 * returns an explanation for every lens of the document's type, so switching lens in the UI never
 * costs another model call. The first lens of each set is the default, also stored as
 * findings.explanation. A lens id is persisted as finding_lens_explanations.role_stage_lens and
 * used as a property name in the model's response schema, so ids stay [a-z_] only.
 */

import type { DocumentTypeId } from "@/server/deterministic/document-type-registry";

/** The two stages every lens set spans, before and after signing. */
export const LENS_STAGES = ["about_to_sign", "already_signed"] as const;
/** One of LENS_STAGES. */
export type LensStage = (typeof LENS_STAGES)[number];

/** One reader perspective the model writes a separate explanation for. */
export interface Lens {
  id: string;
  role: string;
  stage: LensStage;
  // Read by the model: who the reader is and where they stand.
  description: string;
}

function lens(role: string, stage: LensStage, description: string): Lens {
  return { id: `${role}_${stage}`, role, stage, description };
}

const PARTY_LENSES: readonly Lens[] = [
  lens("party", "about_to_sign", "A person who is asked to sign or accept this document and has not done so yet"),
  lens("party", "already_signed", "A person who has already signed or accepted this document and is bound by it now"),
];

/** The lens set for each document type; grounded_response and generic share the generic party lenses. */
export const LENSES_BY_DOCUMENT_TYPE: Record<DocumentTypeId, readonly Lens[]> = {
  leave_and_license: [
    lens("tenant", "about_to_sign", "The tenant (licensee) who will live in the premises, before signing — can still negotiate or walk away"),
    lens("tenant", "already_signed", "The tenant (licensee) who has already signed and is living in, or about to move into, the premises"),
    lens("landlord", "about_to_sign", "The landlord (licensor) who owns the premises, before signing"),
    lens("landlord", "already_signed", "The landlord (licensor) who has already signed and has a tenant in the premises"),
  ],
  job_offer_letter: [
    lens("employee", "about_to_sign", "The candidate who received this offer and has not accepted it yet — can still negotiate or decline"),
    lens("employee", "already_signed", "The employee who has already accepted this offer and joined, or is about to join"),
    lens("employer", "about_to_sign", "The employer issuing this offer, before the candidate accepts it"),
  ],
  nda: [
    lens("receiving_party", "about_to_sign", "The party who will receive confidential information, before signing"),
    lens("receiving_party", "already_signed", "The party who has already signed and is now bound by the confidentiality obligations"),
    lens("disclosing_party", "about_to_sign", "The party who will share its confidential information, before signing"),
  ],
  privacy_policy: [
    lens("user", "about_to_sign", "An individual deciding whether to accept this policy and sign up for the service"),
    lens("user", "already_signed", "An individual who has already accepted this policy and whose personal data is being processed"),
  ],
  freelance_service_agreement: [
    lens("freelancer", "about_to_sign", "The freelancer who will do the work, before signing — can still negotiate scope, payment and terms"),
    lens("freelancer", "already_signed", "The freelancer who has already signed and is doing, or has done, the work"),
    lens("client", "about_to_sign", "The client commissioning the work, before signing"),
  ],
  grounded_response: PARTY_LENSES,
  generic: PARTY_LENSES,
};
