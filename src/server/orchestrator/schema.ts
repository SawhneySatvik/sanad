/**
 * Shared response schema for every specialist call and the synthesis call: no status/verified/
 * quote_span_* field — llm/schema-guard.ts throws before any provider call if one sneaks in.
 * `answer` is declared first: the streaming decoder (answer-stream-decoder.ts) assumes the model
 * emits `{"answer":"..."` as the start of its JSON output.
 */

import { z } from "zod";

/**
 * Bounds the citations kept from one specialist's/the synthesis step's response (and the verify()
 * work they can trigger downstream). services/ask.ts's read budget relies on one Ask turn never
 * carrying more than this. Applied by capCitations() after parsing, never by the schema: a zod
 * .max() reaches the provider as maxItems, which Gemini rejects with 400 "too many states for
 * serving", and an over-citing model should be trimmed, not failed.
 */
export const MAX_CITATIONS_PER_CALL = 20;

/** The zod response schema every specialist call and the synthesis call share; see the module doc. */
export const specialistOutputSchema = z.object({
  answer: z.string(),
  citations: z.array(
    z.object({
      quote: z.string(),
      sourceDocumentId: z.string(),
    }),
  ),
});

/** The parsed shape of specialistOutputSchema. */
export type SpecialistOutput = z.infer<typeof specialistOutputSchema>;
/** One raw, not-yet-verified citation as the model returned it. */
export type RawCitation = SpecialistOutput["citations"][number];

/**
 * Exact repeats of a (sourceDocumentId, quote) pair are dropped first, so a model repeating itself
 * does not use up the cap. Returns how many of each were dropped, for the trim log.
 */
export function capCitations(citations: readonly RawCitation[]): { kept: RawCitation[]; duplicate: number; overCap: number } {
  const seen = new Set<string>();
  const unique: RawCitation[] = [];
  for (const citation of citations) {
    const key = JSON.stringify([citation.sourceDocumentId, citation.quote]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  const kept = unique.slice(0, MAX_CITATIONS_PER_CALL);
  return { kept, duplicate: citations.length - unique.length, overCap: unique.length - kept.length };
}
