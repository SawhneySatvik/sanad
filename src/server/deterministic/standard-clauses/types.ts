/** Vocabulary for the standard-clause checklist: what a checklist item is, and the gap it reports. */

/** One protection a careful reviewer expects in a document of a given type. */
export interface StandardClauseItem {
  /** Unique within its document type; lowercase letters and underscores only. */
  id: string;
  /** Plain-language name of the protection. */
  topic: string;
  /** Shown when the item is absent: what the document does not appear to say, and why that matters. */
  explanation: string;
  /**
   * The item is present if any phrase occurs anywhere in the text. Matching ignores case,
   * punctuation and hyphens, treats singular and plural alike, and treats every number (digits or
   * words) as the same number, so "30 days notice" also matches "thirty days' notice". A different
   * unit does not match: "one month's notice" needs its own phrase.
   */
  presence: readonly string[];
  /**
   * A model-written missing_clause on the same topic: its explanation contains every keyword of at
   * least one group. Narrower than `presence`, because a wrong match here hides a real gap.
   */
  topicKeywords: readonly (readonly string[])[];
}

/**
 * A standard protection the checklist found no wording for. Shaped like Understand's missing_clause
 * findings, but produced by deterministic phrase matching, never by a model. An absence has no
 * quote, so it has no verification either — the literal `null` types keep it that way.
 */
export interface StandardClauseGap {
  /** Stable across documents and runs: `<documentType>.<itemId>`. */
  id: string;
  category: "missing_clause";
  quote: null;
  verification: null;
  topic: string;
  explanation: string;
  provenance: "standard_clause_checklist";
  checklistVersion: string;
}
