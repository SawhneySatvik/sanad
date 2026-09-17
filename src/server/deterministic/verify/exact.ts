import { isTokenBoundary, MAX_GRAPHEME_CHECKS } from "./boundary";
import { normalizeForMatch, type MatchText } from "./normalize";

/**
 * The exact (`verified`) search: the first occurrence of `needle` in the normalized text that starts
 * and ends on unit boundaries (never splitting a base letter from its accents or a surrogate pair)
 * and on a token boundary of the original text (boundary.ts). KMP, O(n + m). Returns raw offsets into
 * `original`, never a VerifyResult — only verify.ts issues those. Exported on its own so a test can
 * feed it a deliberately corrupted MatchText and prove the self-check below stops a wrong span.
 */
export function findExact(
  needle: string,
  original: string,
  match: MatchText,
): { spanStart: number; spanEnd: number } | null {
  const { text, unitOf, unitBoundary } = match;
  const m = needle.length;
  const fail = new Int32Array(m);
  for (let i = 1, j = 0; i < m; i++) {
    while (j > 0 && needle.charCodeAt(i) !== needle.charCodeAt(j)) j = fail[j - 1];
    if (needle.charCodeAt(i) === needle.charCodeAt(j)) j++;
    fail[i] = j;
  }

  const budget = { graphemeChecks: MAX_GRAPHEME_CHECKS };
  for (let i = 0, j = 0; i < text.length; i++) {
    while (j > 0 && text.charCodeAt(i) !== needle.charCodeAt(j)) j = fail[j - 1];
    if (text.charCodeAt(i) === needle.charCodeAt(j)) j++;
    if (j < m) continue;
    const start = i - m + 1;
    const end = i + 1;
    j = fail[m - 1];
    const startsOnUnit = start === 0 || unitOf[start] !== unitOf[start - 1];
    const endsOnUnit = end === text.length || unitOf[end] !== unitOf[end - 1];
    if (!startsOnUnit || !endsOnUnit) continue;

    const spanStart = unitBoundary[unitOf[start]];
    const spanEnd = unitBoundary[unitOf[end - 1] + 1];
    if (!isTokenBoundary(original, spanStart, budget) || !isTokenBoundary(original, spanEnd, budget)) continue;

    // Runtime self-check: the text the UI will highlight normalizes to exactly the quote. If this
    // ever fails, the offset map is wrong — stop rather than scan on, and let the caller fall
    // through to approximate/not_found.
    if (normalizeForMatch(original.slice(spanStart, spanEnd)) !== needle) return null;
    return { spanStart, spanEnd };
  }
  return null;
}
