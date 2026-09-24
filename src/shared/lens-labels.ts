export const LENS_STAGES = ["about_to_sign", "already_signed"] as const;
export type LensStage = (typeof LENS_STAGES)[number];

type LensIdentity = { id: string; role: string; stage: LensStage };

function lens(role: string, stage: LensStage): LensIdentity {
  return { id: `${role}_${stage}`, role, stage };
}

const PARTY_LENSES = [lens("party", "about_to_sign"), lens("party", "already_signed")];

// This small public mirror omits the model prompt descriptions; a parity test keeps ids and order aligned.
export const LENS_IDS_BY_DOCUMENT_TYPE: Record<string, readonly LensIdentity[]> = {
  leave_and_license: [lens("tenant", "about_to_sign"), lens("tenant", "already_signed"), lens("landlord", "about_to_sign"), lens("landlord", "already_signed")],
  job_offer_letter: [lens("employee", "about_to_sign"), lens("employee", "already_signed"), lens("employer", "about_to_sign")],
  nda: [lens("receiving_party", "about_to_sign"), lens("receiving_party", "already_signed"), lens("disclosing_party", "about_to_sign")],
  privacy_policy: [lens("user", "about_to_sign"), lens("user", "already_signed")],
  freelance_service_agreement: [lens("freelancer", "about_to_sign"), lens("freelancer", "already_signed"), lens("client", "about_to_sign")],
  grounded_response: PARTY_LENSES,
  generic: PARTY_LENSES,
};

const ROLE_LABELS: Record<string, string> = {
  tenant: "Tenant", landlord: "Landlord", employee: "Employee", employer: "Employer",
  receiving_party: "Receiving party", disclosing_party: "Disclosing party", user: "User",
  freelancer: "Freelancer", client: "Client", party: "Party",
};

const STAGE_LABELS: Record<LensStage, string> = {
  about_to_sign: "before signing",
  already_signed: "already signed",
};

export function lensLabelParts(lens: { role: string; stage: string }): { role: string; stage: string } {
  const role = ROLE_LABELS[lens.role] ?? lens.role.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const stage = lens.stage in STAGE_LABELS ? STAGE_LABELS[lens.stage as LensStage] : lens.stage.replace(/_/g, " ");
  return { role, stage };
}

export function lensLabel(lens: { role: string; stage: string }): string {
  const { role, stage } = lensLabelParts(lens);
  return `${role}, ${stage}`;
}
