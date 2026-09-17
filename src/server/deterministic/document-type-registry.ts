/**
 * The single source of truth for document types — the id list, per-type detection phrases, and
 * prompt/template references. A Postgres CHECK constraint mirrors {@link DOCUMENT_TYPE_IDS} exactly.
 */

/**
 * Every document-type id, as a literal tuple; document-type-registry.test.ts asserts the
 * registry's own entry ids match it exactly.
 */
export const DOCUMENT_TYPE_IDS = [
  "leave_and_license",
  "job_offer_letter",
  "nda",
  "privacy_policy",
  "freelance_service_agreement",
  "grounded_response",
  "generic",
] as const;

/** One of {@link DOCUMENT_TYPE_IDS}. */
export type DocumentTypeId = (typeof DOCUMENT_TYPE_IDS)[number];

/**
 * A phrase contributing `weight` to a document type's score when it appears as a whole word/phrase
 * in a document's text — higher weight means more distinctive of that type. `concept` groups
 * alternate phrasings of the same idea (e.g. "licensor"/"landlord"): detect-type.ts scores each
 * concept once, by its best-matching phrase, so a document using only one phrasing per concept can
 * still reach full confidence.
 */
export interface DetectionPhrase {
  phrase: string;
  weight: number;
  concept: string;
}

/** One entry in the document-type registry: id, label, detection phrases, and prompt/template references. */
export interface DocumentTypeEntry {
  id: DocumentTypeId;
  label: string;
  // Empty for a type that's never auto-detected from a document's own text (generic is a pure
  // fallback; grounded_response is a Draft-only category the user picks) — detect-type.ts skips
  // scoring any entry with an empty signature.
  detectionSignature: DetectionPhrase[];
  jurisdictions: string[];
  understandPromptRef: string;
  draftTemplateRef?: string;
}

/**
 * Every document type this app knows: the 5 deeply-tuned types, the `grounded_response` drafting
 * category, and the `generic` fallback.
 */
export const DOCUMENT_TYPE_REGISTRY: DocumentTypeEntry[] = [
  {
    id: "leave_and_license",
    label: "Leave and License Agreement (Rental)",
    detectionSignature: [
      { phrase: "leave and license agreement", weight: 5, concept: "document_name" },
      { phrase: "leave and license", weight: 4, concept: "document_name" },
      // British spelling ("licence") is the norm in Indian-drafted deeds; "licensor"/"licensee"
      // are spelled the same in both varieties, so only the noun "license"/"licence" needs a twin.
      { phrase: "leave and licence agreement", weight: 5, concept: "document_name" },
      { phrase: "leave and licence", weight: 4, concept: "document_name" },
      { phrase: "licensor", weight: 3, concept: "grantor" },
      { phrase: "licensee", weight: 3, concept: "grantee" },
      // Ordinary Indian rental documents often use "Rent Agreement"/"Landlord"/"Tenant" phrasing
      // instead of leave-and-license terminology — same concepts, colloquial names.
      { phrase: "rent agreement", weight: 4, concept: "document_name" },
      { phrase: "rental agreement", weight: 4, concept: "document_name" },
      { phrase: "landlord", weight: 3, concept: "grantor" },
      { phrase: "tenant", weight: 3, concept: "grantee" },
      { phrase: "security deposit", weight: 2, concept: "security_deposit" },
      { phrase: "monthly rent", weight: 2, concept: "periodic_fee" },
      { phrase: "license fee", weight: 2, concept: "periodic_fee" },
      { phrase: "licence fee", weight: 2, concept: "periodic_fee" },
      { phrase: "lock-in period", weight: 2, concept: "lock_in" },
      { phrase: "eleven months", weight: 2, concept: "term_length" },
      { phrase: "11 months", weight: 2, concept: "term_length" },
      // Omitted "license/licence period": it appears in any licence, not only property deeds
      // (pinned in detect-type.test.ts).
      { phrase: "vacant possession", weight: 1, concept: "vacant_possession" },
    ],
    jurisdictions: ["IN"],
    understandPromptRef: "understand/leave_and_license",
    draftTemplateRef: "draft/leave_and_license",
  },
  {
    id: "job_offer_letter",
    label: "Job Offer Letter",
    detectionSignature: [
      { phrase: "offer letter", weight: 5, concept: "document_name" },
      { phrase: "letter of offer", weight: 5, concept: "document_name" },
      { phrase: "offer of employment", weight: 5, concept: "document_name" },
      { phrase: "employment offer", weight: 5, concept: "document_name" },
      { phrase: "appointment letter", weight: 4, concept: "document_name" },
      { phrase: "letter of appointment", weight: 4, concept: "document_name" },
      { phrase: "date of joining", weight: 3, concept: "joining_date" },
      { phrase: "notice period", weight: 2, concept: "notice_period" },
      { phrase: "probation period", weight: 2, concept: "probation" },
      { phrase: "ctc", weight: 2, concept: "compensation" },
      { phrase: "cost to company", weight: 2, concept: "compensation" },
      { phrase: "non-compete", weight: 1, concept: "non_compete" },
      { phrase: "bond", weight: 1, concept: "bond" },
    ],
    jurisdictions: ["IN"],
    understandPromptRef: "understand/job_offer_letter",
    draftTemplateRef: "draft/job_offer_letter",
  },
  {
    id: "nda",
    label: "Non-Disclosure Agreement",
    detectionSignature: [
      { phrase: "non-disclosure agreement", weight: 5, concept: "document_name" },
      { phrase: "non disclosure agreement", weight: 5, concept: "document_name" },
      { phrase: "confidentiality agreement", weight: 5, concept: "document_name" },
      { phrase: "confidential information", weight: 3, concept: "confidential_info" },
      { phrase: "disclosing party", weight: 3, concept: "disclosing_party" },
      { phrase: "receiving party", weight: 3, concept: "receiving_party" },
      { phrase: "nda", weight: 2, concept: "document_name" },
      { phrase: "confidentiality obligations", weight: 2, concept: "confidentiality_obligations" },
      { phrase: "mutual non-disclosure", weight: 2, concept: "document_name" },
    ],
    jurisdictions: ["IN"],
    understandPromptRef: "understand/nda",
    draftTemplateRef: "draft/nda",
  },
  {
    id: "privacy_policy",
    label: "Privacy Policy",
    detectionSignature: [
      { phrase: "privacy policy", weight: 5, concept: "document_name" },
      { phrase: "privacy notice", weight: 5, concept: "document_name" },
      { phrase: "data protection policy", weight: 5, concept: "document_name" },
      { phrase: "personal data", weight: 3, concept: "personal_data" },
      { phrase: "digital personal data protection act", weight: 4, concept: "dpdp_act" },
      { phrase: "dpdp act", weight: 4, concept: "dpdp_act" },
      // "Data Fiduciary" (DPDP Act) and "Data Controller" (the GDPR-derived term some Indian
      // policies still use) name the same role.
      { phrase: "data fiduciary", weight: 3, concept: "data_handler" },
      { phrase: "data principal", weight: 3, concept: "data_subject" },
      { phrase: "data controller", weight: 2, concept: "data_handler" },
      { phrase: "cookies", weight: 1, concept: "cookies" },
    ],
    jurisdictions: ["IN"],
    understandPromptRef: "understand/privacy_policy",
    draftTemplateRef: "draft/privacy_policy",
  },
  {
    id: "freelance_service_agreement",
    label: "Freelance Service Agreement",
    detectionSignature: [
      { phrase: "freelance service agreement", weight: 5, concept: "document_name" },
      { phrase: "freelance services agreement", weight: 5, concept: "document_name" },
      { phrase: "independent contractor", weight: 3, concept: "contractor_role" },
      { phrase: "scope of work", weight: 2, concept: "work_scope" },
      { phrase: "statement of work", weight: 2, concept: "work_scope" },
      { phrase: "service agreement", weight: 2, concept: "document_name" },
      { phrase: "services agreement", weight: 2, concept: "document_name" },
      { phrase: "consultancy agreement", weight: 2, concept: "document_name" },
      { phrase: "consulting agreement", weight: 2, concept: "document_name" },
      { phrase: "independent contractor agreement", weight: 2, concept: "document_name" },
      { phrase: "master services agreement", weight: 2, concept: "document_name" },
      { phrase: "deliverables", weight: 2, concept: "deliverables" },
      { phrase: "freelancer", weight: 3, concept: "contractor_role" },
      { phrase: "consultant agreement", weight: 2, concept: "document_name" },
    ],
    jurisdictions: ["IN"],
    understandPromptRef: "understand/freelance_service_agreement",
    draftTemplateRef: "draft/freelance_service_agreement",
  },
  {
    id: "grounded_response",
    label: "Grounded Response Draft",
    detectionSignature: [],
    jurisdictions: ["IN"],
    understandPromptRef: "understand/grounded_response",
    draftTemplateRef: "draft/grounded_response",
  },
  {
    id: "generic",
    label: "Generic Document",
    detectionSignature: [],
    jurisdictions: ["IN"],
    understandPromptRef: "understand/generic",
  },
];
