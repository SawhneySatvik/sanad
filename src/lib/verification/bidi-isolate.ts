/**
 * GET /api/documents/:id/text returns canonical_text byte-exact — bidi control characters
 * (U+202E RIGHT-TO-LEFT OVERRIDE and its siblings) included, because bindSpan()'s slice check
 * depends on offsets matching what verify() ran against; the server never strips them from this
 * one field. A hostile document can embed one to make displayed text read in a different order
 * than its logical order, or make a highlight visually land over the wrong words.
 *
 * `unicode-bidi: isolate` contains a bidi override to the element it's set on: an RLO opened inside
 * one segment/mark cannot flip the direction of a sibling segment or the surrounding chrome. It
 * changes nothing about the text itself — `textContent` is untouched, so `mark.textContent ===
 * spanText` still holds exactly.
 *
 * claimedQuote (model text) is not in scope here: sanitizeModelText() already strips these same
 * bidi control characters server-side (src/server/deterministic/sanitize/model-text.ts) before it
 * reaches the wire, so nothing renders it unisolated.
 */
export const BIDI_ISOLATE_STYLE = { unicodeBidi: "isolate" } as const;
