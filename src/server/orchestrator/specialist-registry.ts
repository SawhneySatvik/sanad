/**
 * The orchestrator's specialist registry. Deliberately a separate registry from
 * src/server/deterministic/document-type-registry.ts: document-type is the Understand/Draft axis
 * (auto-detected from a document's own text), this is the Ask/routing axis (which specialist(s)
 * answer a query). They share default id names by coincidence of scope, not because they're the
 * same enum — this file never imports that one, and `documentTypeAffinity` below is a plain
 * string, not `DocumentTypeId`.
 */

/** The Ask/routing specialist ids; see the module doc for how this differs from document-type ids. */
export const SPECIALIST_IDS = [
  "tenancy",
  "employment",
  "contracts_nda",
  "privacy",
  "freelance",
  "general_legal",
] as const;

/** One of SPECIALIST_IDS. */
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

/**
 * A keyword/phrase contributes `weight` to a specialist's classification score when it
 * appears (whole-word/whole-phrase, case-insensitive) in the query text — same shape and
 * matching rule as document-type-registry.ts's DetectionPhrase, independently defined here
 * (see file header).
 */
export interface ClassifierKeyword {
  phrase: string;
  weight: number;
}

/** One specialist's classification keywords, prompt reference and document-type affinity. */
export interface SpecialistEntry {
  id: SpecialistId;
  label: string;
  classifierKeywords: ClassifierKeyword[];
  // A stable, documented reference name — not a dynamic lookup key: specialists.ts looks up
  // prompts by `id` directly, so a typo here can't silently break dispatch.
  promptRef: string;
  // Document-type-registry ids this specialist is tuned for; boosts its classification score
  // when a grounded-mode query's document matches (classify.ts's DOCUMENT_AFFINITY_BOOST). Plain
  // strings, decoupled by design (file header) — a rename on either side is a one-line diff here.
  documentTypeAffinity: string[];
}

/**
 * general_legal is the catch-all (criminal, family, consumer, property, inheritance, and
 * anything else): broad taxonomy, deep tuning only on the focus areas above. Its own
 * `classifierKeywords` are deliberately narrow/other-area-specific (FIR, divorce, consumer
 * forum, ...), not generic legal words like "legal"/"law"/"rights" — those live in classify.ts's
 * separate GENERAL_LEGAL_ANGLE_INDICATORS list, used only for the legal-vs-non_legal gate, so an
 * everyday sentence that merely contains the word "will" ("will you help me") doesn't fan out
 * into a wasted general_legal call.
 */
export const SPECIALIST_REGISTRY: SpecialistEntry[] = [
  {
    id: "tenancy",
    label: "Tenancy",
    promptRef: "orchestrator/tenancy",
    documentTypeAffinity: ["leave_and_license"],
    classifierKeywords: [
      { phrase: "rent", weight: 2 },
      { phrase: "landlord", weight: 3 },
      { phrase: "tenant", weight: 3 },
      { phrase: "lease", weight: 3 },
      { phrase: "leave and license", weight: 4 },
      { phrase: "licensor", weight: 3 },
      { phrase: "licensee", weight: 3 },
      { phrase: "eviction", weight: 3 },
      { phrase: "evict", weight: 3 },
      { phrase: "security deposit", weight: 2 },
      { phrase: "rental agreement", weight: 4 },
      { phrase: "rent agreement", weight: 4 },
      { phrase: "notice to vacate", weight: 3 },
      { phrase: "sub-lease", weight: 2 },
      { phrase: "sublet", weight: 2 },
      { phrase: "rent control", weight: 2 },
      { phrase: "maintenance charges", weight: 1 },
      { phrase: "society noc", weight: 1 },
      { phrase: "lock-in period", weight: 1 },
      // Layperson phrasing that drops "security" — "deposit" alone is a weaker/more ambiguous
      // signal (bank/escrow deposits exist too) hence the low weight.
      { phrase: "deposit", weight: 1 },
    ],
  },
  {
    id: "employment",
    label: "Employment",
    promptRef: "orchestrator/employment",
    documentTypeAffinity: ["job_offer_letter"],
    classifierKeywords: [
      { phrase: "employment", weight: 3 },
      { phrase: "employer", weight: 2 },
      { phrase: "employee", weight: 2 },
      { phrase: "salary", weight: 2 },
      { phrase: "termination", weight: 2 },
      { phrase: "notice period", weight: 2 },
      { phrase: "offer letter", weight: 4 },
      { phrase: "appointment letter", weight: 4 },
      { phrase: "probation", weight: 3 },
      { phrase: "resignation", weight: 3 },
      { phrase: "gratuity", weight: 3 },
      { phrase: "provident fund", weight: 3 },
      { phrase: "pf withdrawal", weight: 2 },
      { phrase: "non-compete", weight: 2 },
      { phrase: "workplace harassment", weight: 3 },
      { phrase: "posh act", weight: 3 },
      { phrase: "wrongful termination", weight: 3 },
      { phrase: "bonus", weight: 1 },
      { phrase: "notice pay", weight: 2 },
      // "HR" is a near-universal shorthand for anything employment-related. "terminate"/
      // "terminated" cover verb-form phrasing "termination" alone misses — inflection covers
      // "terminates" but not the e-dropping form "terminated", hence it's listed explicitly.
      { phrase: "hr", weight: 2 },
      { phrase: "terminate", weight: 2 },
      { phrase: "terminated", weight: 2 },
    ],
  },
  {
    id: "contracts_nda",
    label: "Contracts & NDAs",
    promptRef: "orchestrator/contracts_nda",
    documentTypeAffinity: ["nda"],
    classifierKeywords: [
      { phrase: "nda", weight: 4 },
      { phrase: "non-disclosure", weight: 4 },
      { phrase: "confidentiality agreement", weight: 4 },
      { phrase: "confidential information", weight: 3 },
      { phrase: "contract", weight: 2 },
      { phrase: "agreement", weight: 1 },
      { phrase: "breach of contract", weight: 3 },
      { phrase: "indemnity", weight: 2 },
      { phrase: "indemnification", weight: 2 },
      { phrase: "governing law", weight: 2 },
      { phrase: "arbitration clause", weight: 3 },
      { phrase: "termination clause", weight: 2 },
      { phrase: "force majeure", weight: 2 },
      { phrase: "mutual nda", weight: 4 },
      // Verb-form contract-law phrasing. Bare "clause" is deliberately not added here — it lives
      // in classify.ts's GENERAL_LEGAL_ANGLE_INDICATORS instead, to avoid scoring contracts_nda
      // directly for a generic "what does clause 4 mean?" question with no contract keywords.
      { phrase: "terminate", weight: 2 },
      { phrase: "terminated", weight: 2 },
    ],
  },
  {
    id: "privacy",
    label: "Privacy & Data Protection",
    promptRef: "orchestrator/privacy",
    documentTypeAffinity: ["privacy_policy"],
    classifierKeywords: [
      { phrase: "privacy policy", weight: 4 },
      { phrase: "personal data", weight: 3 },
      { phrase: "data protection", weight: 3 },
      { phrase: "dpdp act", weight: 4 },
      { phrase: "data breach", weight: 3 },
      { phrase: "consent form", weight: 2 },
      { phrase: "data controller", weight: 3 },
      { phrase: "data processor", weight: 3 },
      { phrase: "cookies", weight: 2 },
      { phrase: "data retention", weight: 2 },
      { phrase: "personal information", weight: 2 },
      { phrase: "grievance officer", weight: 2 },
      // Bare "consent" (already had the narrower "consent form").
      { phrase: "consent", weight: 2 },
    ],
  },
  {
    id: "freelance",
    label: "Freelance & Gig Work",
    promptRef: "orchestrator/freelance",
    documentTypeAffinity: ["freelance_service_agreement"],
    classifierKeywords: [
      { phrase: "freelance", weight: 4 },
      { phrase: "freelancer", weight: 4 },
      { phrase: "independent contractor", weight: 3 },
      { phrase: "gig worker", weight: 3 },
      { phrase: "scope of work", weight: 3 },
      { phrase: "invoice", weight: 1 },
      { phrase: "payment terms", weight: 2 },
      { phrase: "deliverables", weight: 2 },
      { phrase: "client agreement", weight: 3 },
      { phrase: "service agreement", weight: 3 },
      { phrase: "milestone payment", weight: 2 },
      { phrase: "retainer", weight: 2 },
    ],
  },
  {
    id: "general_legal",
    label: "General Legal (other areas)",
    promptRef: "orchestrator/general_legal",
    documentTypeAffinity: ["generic", "grounded_response"],
    classifierKeywords: [
      { phrase: "fir", weight: 3 },
      { phrase: "police complaint", weight: 3 },
      { phrase: "criminal case", weight: 3 },
      { phrase: "criminal complaint", weight: 3 },
      { phrase: "divorce", weight: 4 },
      { phrase: "child custody", weight: 3 },
      { phrase: "alimony", weight: 3 },
      { phrase: "maintenance petition", weight: 2 },
      { phrase: "consumer forum", weight: 3 },
      { phrase: "consumer complaint", weight: 3 },
      { phrase: "property dispute", weight: 3 },
      { phrase: "inheritance", weight: 3 },
      { phrase: "succession certificate", weight: 3 },
      { phrase: "last will and testament", weight: 3 },
      { phrase: "probate", weight: 3 },
      { phrase: "defamation", weight: 2 },
      { phrase: "bail", weight: 2 },
      { phrase: "anticipatory bail", weight: 3 },
      // Common general Indian property/RWA-law terms outside the specifically tuned domains.
      { phrase: "housing society", weight: 2 },
      { phrase: "sale deed", weight: 3 },
      { phrase: "bylaws", weight: 2 },
    ],
  },
];
