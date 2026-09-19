/**
 * The orchestrator's domain classifier: deterministic keyword/heuristic only — no LLM call, no
 * embedding call (no `embed()` exists on `LlmClient`). Mirrors
 * src/server/deterministic/detect-type.ts's whole-word-phrase scoring approach, reimplemented
 * locally rather than imported, so this file has no runtime dependency on that module.
 */

import type { OrchestratorDocumentInput } from "./types";
import { SPECIALIST_REGISTRY, type SpecialistId } from "./specialist-registry";

/** One specialist and its keyword+affinity score, highest first in classify()'s output. */
export interface RankedDomain {
  readonly id: SpecialistId;
  readonly score: number;
}

/** classify()'s result: a ranked domain list, or the non-legal redirect. */
export type ClassifyResult =
  | { readonly kind: "legal"; readonly domains: readonly RankedDomain[] }
  | { readonly kind: "non_legal" };

// A document attached with a `documentType` this specialist is tuned for is strong
// evidence the query belongs (at least partly) to that domain, even if the query text
// itself carries no keyword signal (e.g. "what does clause 4 mean?").
const DOCUMENT_AFFINITY_BOOST = 4;

/**
 * Phrases that are positive evidence a query has nothing to do with law. A query routes to
 * `non_legal` only when it has no document attached, matches no specialist's keywords, and matches
 * one of these; a query with no evidence either way goes to general_legal, because a refused legal
 * question is worse than a disclaimed non-legal one answered as general information. Each entry is
 * a strong signal on its own, not an everyday word with a non-legal sense that also happens to
 * appear in off-topic text.
 */
const NON_LEGAL_SIGNALS: ClassifierKeywordLike[] = [
  // Cooking/recipes
  { phrase: "recipe", weight: 3 },
  { phrase: "cooking", weight: 2 },
  { phrase: "cook", weight: 2 },
  { phrase: "ingredients", weight: 2 },
  { phrase: "bake", weight: 2 },
  // Coding/programming
  { phrase: "python", weight: 3 },
  { phrase: "javascript", weight: 3 },
  { phrase: "programming", weight: 3 },
  { phrase: "coding", weight: 3 },
  { phrase: "algorithm", weight: 2 },
  { phrase: "linked list", weight: 3 },
  { phrase: "css", weight: 2 },
  { phrase: "debug", weight: 2 },
  // Sports scores/trivia — bare "cricket"/"football" as a fallback for phrasing that doesn't
  // keep "match" adjacent ("how many players are on a cricket team").
  { phrase: "cricket", weight: 2 },
  { phrase: "football", weight: 2 },
  { phrase: "world cup", weight: 3 },
  { phrase: "ipl", weight: 3 },
  { phrase: "olympics", weight: 2 },
  { phrase: "match score", weight: 3 },
  { phrase: "penalty shootout", weight: 3 },
  { phrase: "tournament", weight: 2 },
  // Weather
  { phrase: "weather", weight: 3 },
  { phrase: "rain", weight: 2 },
  { phrase: "rainfall", weight: 2 },
  { phrase: "forecast", weight: 2 },
  { phrase: "monsoon", weight: 2 },
  // Entertainment trivia
  { phrase: "movie", weight: 2 },
  { phrase: "web series", weight: 2 },
  { phrase: "actor", weight: 2 },
  { phrase: "actress", weight: 2 },
  { phrase: "celebrity", weight: 2 },
  { phrase: "box office", weight: 2 },
  { phrase: "song", weight: 2 },
  // Maths homework
  { phrase: "math problem", weight: 3 },
  { phrase: "maths", weight: 2 },
  { phrase: "algebra", weight: 3 },
  { phrase: "geometry", weight: 2 },
  { phrase: "homework", weight: 3 },
  // Travel booking
  { phrase: "itinerary", weight: 3 },
  { phrase: "trekking", weight: 2 },
  { phrase: "sightseeing", weight: 2 },
  { phrase: "vacation", weight: 2 },
  { phrase: "flight", weight: 2 },
  { phrase: "hotel booking", weight: 3 },
  // Gifts/shopping. Bare "gift" is deliberately absent — "gifted"/"gift deed" are real property-
  // law terms (a gift of property), so this category is represented only by shopping-intent
  // phrases and festival/occasion names below, never the bare word.
  { phrase: "gift ideas", weight: 3 },
  { phrase: "birthday gift", weight: 2 },
  { phrase: "birthday", weight: 2 },
  { phrase: "anniversary", weight: 2 },
  { phrase: "wedding gift", weight: 2 },
  { phrase: "housewarming", weight: 2 },
  { phrase: "what to gift", weight: 3 },
  { phrase: "gift suggestion", weight: 3 },
  { phrase: "shopping for", weight: 2 },
  // Festivals/greetings/celebrations — occasion names a gift/greeting question is almost always
  // tied to in Indian context; safe (no legal-document sense) unlike "gift" itself.
  { phrase: "diwali", weight: 3 },
  { phrase: "holi", weight: 3 },
  { phrase: "eid", weight: 3 },
  { phrase: "christmas", weight: 3 },
  { phrase: "raksha bandhan", weight: 3 },
  { phrase: "rakhi", weight: 2 },
  { phrase: "navratri", weight: 2 },
  { phrase: "greeting message", weight: 2 },
  // Personal/relationship advice
  { phrase: "boyfriend", weight: 3 },
  { phrase: "girlfriend", weight: 3 },
  { phrase: "dating", weight: 2 },
  { phrase: "crush", weight: 2 },
  { phrase: "relationship advice", weight: 3 },
  // Health/fitness/diet
  { phrase: "diet plan", weight: 3 },
  { phrase: "weight loss", weight: 2 },
  { phrase: "home remedy", weight: 2 },
  { phrase: "fitness routine", weight: 2 },
  { phrase: "workout routine", weight: 2 },
  // Travel/tourism (see also the travel-booking entries above)
  { phrase: "tourist", weight: 2 },
  { phrase: "honeymoon", weight: 2 },
  // Entertainment/hobbies (see also the entertainment-trivia entries above)
  { phrase: "hobby", weight: 2 },
  { phrase: "hobbies", weight: 2 },
  { phrase: "garden", weight: 2 },
  { phrase: "gardening", weight: 2 },
  { phrase: "photography", weight: 2 },
  { phrase: "instagram", weight: 3 },
  { phrase: "caption", weight: 2 },
  { phrase: "poem", weight: 3 },
  // General knowledge/trivia. Bare "capital"/"score" are absent — "share capital"/"CIBIL score"
  // are real financial-legal terms.
  { phrase: "trivia", weight: 3 },
  { phrase: "world record", weight: 2 },
  { phrase: "fun fact", weight: 2 },
  // Education/homework (see also the maths-homework entries above)
  { phrase: "exam preparation", weight: 3 },
  { phrase: "study tips", weight: 2 },
  { phrase: "school project", weight: 2 },
];

interface ClassifierKeywordLike {
  phrase: string;
  weight: number;
}

const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

// A layperson inflects ("contract" -> "contracts") far more than legal prose does, so a bare
// whole-word match under-matches; tolerated suffixes are s/es/ing/ed, gated by a minimum
// last-word length (4) so a short keyword ("fir") doesn't also match an unrelated word ("fired").
const INFLECTION_SUFFIXES = "(?:s|es|ing|ed)?";
const MIN_LAST_WORD_LENGTH_FOR_INFLECTION = 4;

function lastWordOf(phrase: string): string {
  const words = phrase.split(/[\s-]+/).filter((w) => w.length > 0);
  return words.length > 0 ? words[words.length - 1] : phrase;
}

// Whole-word/whole-phrase, case-insensitive substring match, inflection-tolerant on the phrase's
// last word — same boundary rule as detect-type.ts's includesWholeWordPhrase (a bare
// `.includes("nda")` also matches inside "standard"), reimplemented locally (file header).
function includesWholeWordPhrase(haystack: string, lowerPhrase: string): boolean {
  const escaped = lowerPhrase.replace(REGEXP_METACHARACTERS, "\\$&");
  const suffix = lastWordOf(lowerPhrase).length >= MIN_LAST_WORD_LENGTH_FOR_INFLECTION ? INFLECTION_SUFFIXES : "";
  return new RegExp(`(?<![a-z0-9])${escaped}${suffix}(?![a-z0-9])`).test(haystack);
}

function scoreKeywords(haystack: string, keywords: readonly ClassifierKeywordLike[]): number {
  let score = 0;
  for (const { phrase, weight } of keywords) {
    if (includesWholeWordPhrase(haystack, phrase.toLowerCase())) score += weight;
  }
  return score;
}

/**
 * Deterministic, zero-LLM classification. Ranks every specialist whose keyword score (query text)
 * plus document-affinity boost (attached documents' `documentType`) is > 0, highest first (ties
 * keep SPECIALIST_REGISTRY's declared order — Array#sort is stable).
 *
 * If nothing scores, the redirect to `non_legal` requires POSITIVE evidence the query is
 * off-topic (`NON_LEGAL_SIGNALS`) — a refused legal question is a worse outcome than a disclaimed
 * non-legal one answered as general information, so an ambiguous query with no signal either way
 * falls back to `general_legal` rather than being redirected. A document is attached (grounded
 * mode inherently has a legal document in context, even if this turn's question text alone reads
 * as off-topic — e.g. "what does clause 4 mean?") always skips the non-legal check entirely.
 */
export function classify(query: string, documents?: readonly OrchestratorDocumentInput[]): ClassifyResult {
  const haystack = (typeof query === "string" ? query : "").toLowerCase();
  const docs = documents ?? [];

  const scored: RankedDomain[] = SPECIALIST_REGISTRY.map((entry) => {
    let score = scoreKeywords(haystack, entry.classifierKeywords);
    for (const doc of docs) {
      if (doc.documentType && entry.documentTypeAffinity.includes(doc.documentType)) {
        score += DOCUMENT_AFFINITY_BOOST;
      }
    }
    return { id: entry.id, score };
  });

  const matched = scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score);
  if (matched.length > 0) return { kind: "legal", domains: matched };

  if (docs.length === 0 && scoreKeywords(haystack, NON_LEGAL_SIGNALS) > 0) {
    return { kind: "non_legal" };
  }

  return { kind: "legal", domains: [{ id: "general_legal", score: 1 }] };
}
