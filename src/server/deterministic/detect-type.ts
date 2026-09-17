import { DOCUMENT_TYPE_REGISTRY, type DocumentTypeId } from "./document-type-registry";

/** Deterministic, keyword-based document-type detection — no LLM, no embeddings. */

/**
 * Conservative on purpose: below this fraction of matched concept weight (grouped synonyms scored
 * once, each concept counted at most once toward maxScore), falls back to "generic" rather than
 * committing to a wrong type. Measured: single-concept noise tops out at 0.42; every tuned type's
 * real fixture reaches at least 0.80. A partial-but-real document (2-3 concepts, no document name)
 * can fall between — 0.44-0.47 — and lands generic; that trade-off is deliberate. A title-less host
 * document that also cross-references another type's full document name can reach exactly 0.50 and
 * commit to the wrong type — a known, narrower risk, not covered by this threshold alone.
 */
const CONFIDENCE_THRESHOLD = 0.5;

/** A document's inferred type and the confidence (0–1) score behind it. */
export interface DetectionResult {
  documentType: DocumentTypeId;
  confidence: number;
}

const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Whether `lowerPhrase` occurs in `haystack` as a whole word or phrase, not merely as a substring —
 * a plain `includes("nda")` would also match inside "standard" or "calendar".
 */
export function includesWholeWordPhrase(haystack: string, lowerPhrase: string): boolean {
  const escaped = lowerPhrase.replace(REGEXP_METACHARACTERS, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystack);
}

/**
 * Infers a document's type by scoring each registry entry's matched concepts and returning the
 * highest scorer, or "generic" if none clears {@link CONFIDENCE_THRESHOLD}. Phrases that share a
 * `concept` (alternate phrasings of the same idea, e.g. "licensor"/"landlord") are scored once, by
 * whichever member matched with the highest weight — so a correctly-worded document that uses only
 * one phrasing per concept isn't penalized against the signature's other, unused synonyms.
 */
export function detectDocumentType(canonicalText: string): DetectionResult {
  const haystack = canonicalText.toLowerCase();

  let best: { id: DocumentTypeId; score: number; maxScore: number } | null = null;

  for (const entry of DOCUMENT_TYPE_REGISTRY) {
    if (entry.detectionSignature.length === 0) continue;

    const concepts = new Map<string, { maxWeight: number; matchedWeight: number }>();
    for (const { phrase, weight, concept } of entry.detectionSignature) {
      const group = concepts.get(concept) ?? { maxWeight: 0, matchedWeight: 0 };
      group.maxWeight = Math.max(group.maxWeight, weight);
      if (includesWholeWordPhrase(haystack, phrase.toLowerCase())) {
        group.matchedWeight = Math.max(group.matchedWeight, weight);
      }
      concepts.set(concept, group);
    }

    let score = 0;
    let maxScore = 0;
    for (const { maxWeight, matchedWeight } of concepts.values()) {
      maxScore += maxWeight;
      score += matchedWeight;
    }

    if (!best || score > best.score) {
      best = { id: entry.id, score, maxScore };
    }
  }

  if (!best || best.score === 0) {
    return { documentType: "generic", confidence: 0 };
  }

  const confidence = best.score / best.maxScore;
  if (confidence < CONFIDENCE_THRESHOLD) {
    return { documentType: "generic", confidence };
  }

  return { documentType: best.id, confidence };
}
