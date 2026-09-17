/** Draft template vocabulary. Every draftable document-type registry entry gets exactly one DraftTemplate. */

/**
 * A section's origin: fixed boilerplate the app writes, or text the model generates. A closed union,
 * not the open-ended `string` the DB column allows, so a value implying verification can't
 * type-check as one. Extend this union — never widen it to `string` — for a new provenance kind.
 */
export type DraftProvenance = "templated" | "ai_generated";

/** One section of a draft template. */
export interface DraftSectionTemplate {
  key: string;
  heading: string;
  provenance: DraftProvenance;
  // Required for a templated section (the model never produces this text); undefined for ai_generated.
  body?: string;
  // Required for an ai_generated section: what its body IS, its voice/person, and its addressee
  // where relevant — carried into the draft prompt next to the section's key so the model can't
  // pattern-match a neighboring section's voice. Undefined for a templated section.
  guidance?: string;
}

/** A document type's ordered draft skeleton. */
export interface DraftTemplate {
  documentType: string;
  // This array IS the section order — the persisted rows carry no ordinal column.
  sections: DraftSectionTemplate[];
}
