/**
 * The bounded fuzzy matcher behind `approximate`. Works on lowercased word tokens of the
 * already-normalized text, so case and punctuation drift cost nothing and a changed/added/dropped
 * word costs one edit. Returns raw token positions and counts, never a VerifyResult — only verify.ts
 * issues one. Every bound below exists because a slow verify blocks other requests on the same
 * instance: work stays capped regardless of document or quote size.
 */

/** Quotes shorter than this are never scored. */
export const MIN_APPROX_QUOTE_TOKENS = 3;
/** Quotes longer than this are never scored — bounds alignment work at the top end. */
export const MAX_APPROX_QUOTE_TOKENS = 200;
/**
 * At most this many candidate windows are aligned per quote, each over a bounded-size region —
 * see {@link findApproximate}.
 */
export const MAX_CANDIDATE_WINDOWS = 8;

/** The maximum edits a quote of `quoteTokens` words may have and still pass (token similarity >= 0.8). */
export function maxEditsFor(quoteTokens: number): number {
  return Math.floor(quoteTokens / 5);
}

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** A document's word tokens, ready for fuzzy search. */
export type TokenIndex = {
  readonly ids: Int32Array;
  // [start, end) of each token in the normalized text.
  readonly normStart: Int32Array;
  readonly normEnd: Int32Array;
  readonly vocab: ReadonlyMap<string, number>;
};

/** Tokenizes a document's normalized text into a {@link TokenIndex} for {@link findApproximate}. */
export function indexTokens(normalizedText: string): TokenIndex {
  const vocab = new Map<string, number>();
  const ids: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const m of normalizedText.matchAll(WORD)) {
    const word = m[0].toLowerCase();
    let id = vocab.get(word);
    if (id === undefined) {
      id = vocab.size;
      vocab.set(word, id);
    }
    ids.push(id);
    starts.push(m.index);
    ends.push(m.index + m[0].length);
  }
  return {
    ids: Int32Array.from(ids),
    normStart: Int32Array.from(starts),
    normEnd: Int32Array.from(ends),
    vocab,
  };
}

/**
 * Tokenizes a normalized quote against a document's vocabulary. Quote words unknown to the document
 * get -1: they can never match a document token, but still count toward the quote's length.
 */
export function quoteTokenIds(normalizedQuote: string, vocab: ReadonlyMap<string, number>): Int32Array {
  const ids: number[] = [];
  for (const m of normalizedQuote.matchAll(WORD)) {
    ids.push(vocab.get(m[0].toLowerCase()) ?? -1);
  }
  return Int32Array.from(ids);
}

/** The outcome of {@link findApproximate}. */
export type ApproximateSearch = {
  // Token range [startToken, endToken) of the best alignment that passed the threshold, or null.
  readonly match: { readonly startToken: number; readonly endToken: number; readonly edits: number } | null;
  // Work actually done — asserted by the timing tests against findApproximate's own bound.
  readonly candidatesAligned: number;
  readonly alignmentCells: number;
};

const NO_MATCH: ApproximateSearch = { match: null, candidatesAligned: 0, alignmentCells: 0 };

/**
 * Finds the best fuzzy match for `quote`'s tokens in `doc`, or none. A linear sliding-window
 * token-overlap prefilter runs first, and only windows that could possibly pass the edit-distance
 * threshold are aligned — at most {@link MAX_CANDIDATE_WINDOWS} of them, each over a region of fewer
 * than 3·k + 3 tokens, so total alignment work is bounded regardless of document size.
 */
export function findApproximate(quote: Int32Array, doc: TokenIndex): ApproximateSearch {
  const k = quote.length;
  const n = doc.ids.length;
  if (k < MIN_APPROX_QUOTE_TOKENS || k > MAX_APPROX_QUOTE_TOKENS || n === 0) return NO_MATCH;

  const maxEdits = maxEditsFor(k);
  // An alignment with d <= maxEdits pairs at least k - d quote tokens with equal document tokens, so
  // its starting window has overlap >= k - 2·maxEdits. Anything below this cannot pass: the
  // prefilter is lossless.
  const minOverlap = k - 2 * maxEdits;

  const vocabSize = doc.vocab.size;
  const quoteCount = new Int32Array(vocabSize);
  for (let i = 0; i < k; i++) if (quote[i] >= 0) quoteCount[quote[i]]++;

  const width = Math.min(k, n);
  const windows = n - width + 1;
  const overlap = new Int32Array(windows);
  const windowCount = new Int32Array(vocabSize);
  let current = 0;
  for (let p = 0; p < n; p++) {
    const added = doc.ids[p];
    if (windowCount[added] < quoteCount[added]) current++;
    windowCount[added]++;
    if (p >= width) {
      const removed = doc.ids[p - width];
      windowCount[removed]--;
      if (windowCount[removed] < quoteCount[removed]) current--;
    }
    if (p >= width - 1) overlap[p - width + 1] = current;
  }

  // Greedy best-first window picking with suppression, so candidates are distinct regions.
  const radius = Math.ceil(k / 2);
  const candidates: number[] = [];
  while (candidates.length < MAX_CANDIDATE_WINDOWS) {
    let best = -1;
    for (let p = 0; p < windows; p++) {
      if (overlap[p] >= minOverlap && (best < 0 || overlap[p] > overlap[best])) best = p;
    }
    if (best < 0) break;
    candidates.push(best);
    const lo = Math.max(0, best - radius);
    const hi = Math.min(windows - 1, best + radius);
    for (let p = lo; p <= hi; p++) overlap[p] = -1;
  }

  // Wide enough that a region suppressed by a neighbour still lies inside this candidate's aligned region.
  const slack = radius + maxEdits + 1;
  let bestMatch: ApproximateSearch["match"] = null;
  let alignmentCells = 0;
  for (const p of candidates) {
    const from = Math.max(0, p - slack);
    const to = Math.min(n, p + width + slack);
    const aligned = alignSemiGlobal(quote, doc.ids, from, to);
    alignmentCells += k * (to - from);
    const startToken = from + aligned.start;
    const endToken = from + aligned.end;
    if (
      bestMatch === null ||
      aligned.edits < bestMatch.edits ||
      (aligned.edits === bestMatch.edits && startToken < bestMatch.startToken)
    ) {
      bestMatch = { startToken, endToken, edits: aligned.edits };
    }
  }

  const passes = bestMatch !== null && bestMatch.edits <= maxEdits && bestMatch.endToken > bestMatch.startToken;
  return { match: passes ? bestMatch : null, candidatesAligned: candidates.length, alignmentCells };
}

// Token edit distance between the whole quote and the best-matching substring of doc[from, to)
// (free start and end in the document). Ties break toward substitution/match, then the earliest
// end, so the result is a pure function of the input.
function alignSemiGlobal(
  quote: Int32Array,
  doc: Int32Array,
  from: number,
  to: number,
): { edits: number; start: number; end: number } {
  const len = to - from;
  let prev = new Int32Array(len + 1);
  let cur = new Int32Array(len + 1);
  let prevStart = new Int32Array(len + 1);
  let curStart = new Int32Array(len + 1);
  for (let j = 0; j <= len; j++) prevStart[j] = j;

  for (let i = 1; i <= quote.length; i++) {
    const q = quote[i - 1];
    cur[0] = i;
    curStart[0] = 0;
    for (let j = 1; j <= len; j++) {
      let best = prev[j - 1] + (q === doc[from + j - 1] ? 0 : 1);
      let bestStart = prevStart[j - 1];
      const skipQuoteWord = prev[j] + 1;
      if (skipQuoteWord < best) {
        best = skipQuoteWord;
        bestStart = prevStart[j];
      }
      const skipDocWord = cur[j - 1] + 1;
      if (skipDocWord < best) {
        best = skipDocWord;
        bestStart = curStart[j - 1];
      }
      cur[j] = best;
      curStart[j] = bestStart;
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }

  let end = 0;
  for (let j = 1; j <= len; j++) if (prev[j] < prev[end]) end = j;
  return { edits: prev[end], start: prevStart[end], end };
}
