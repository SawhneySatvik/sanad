/**
 * A `verified` span must start and end on a token boundary of the original canonical text — without
 * this, "lawful termination" could verify inside "unlawful termination", or a true quote ("30 days")
 * highlight inside "130 days" instead of where it really is. Every cap below fails safe: hitting a
 * limit always counts a position as mid-token, which can only turn a `verified` into a fall-through
 * to approximate/not_found, never the reverse.
 */

const MAX_SKIPPED_FORMAT_CHARS = 32;
// 8 consecutive flags. The parity walk runs once per occurrence, so this cap bounds a document made
// of nothing but flags.
const MAX_REGIONAL_INDICATOR_RUN = 16;
const MAX_CLUSTER_LOOKBEHIND = 64;

/**
 * Grapheme checks cost ~1 µs each; a search stops trusting positions needing one past this many,
 * so a document built to force one at every occurrence stays linear.
 */
export const MAX_GRAPHEME_CHECKS = 4_096;
/** Shared, mutable budget threaded through a single search so its total grapheme-check cost stays bounded. */
export type BoundaryBudget = { graphemeChecks: number };

const WORD = /[\p{L}\p{N}\p{M}]/u;
const DIGIT = /\p{Nd}/u;
const FORMAT = /\p{Cf}/u;
const MARK = /\p{M}/u;
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

const WORD_JOINERS = new Set([0x2d, 0x2010, 0x2011, 0x2013, 0x2014, 0x27, 0x2019]);
const NUMBER_JOINERS = new Set([0x2c, 0x2e, 0x2f]);

const width = (cp: number) => (cp > 0xffff ? 2 : 1);

function codePointBefore(text: string, pos: number): number {
  const low = text.charCodeAt(pos - 1);
  if (low >= 0xdc00 && low <= 0xdfff && pos >= 2) {
    const high = text.charCodeAt(pos - 2);
    if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  return low;
}

const WORD_BIT = 1;
const DIGIT_BIT = 2;
const FORMAT_BIT = 4;
const CONTINUES_CLUSTER_BIT = 8;

function classify(cp: number): number {
  const s = String.fromCodePoint(cp);
  const format = FORMAT.test(s);
  const continuesCluster =
    format || MARK.test(s) || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0xff9e || cp === 0xff9f; // + emoji modifiers, halfwidth sound marks
  return (
    (WORD.test(s) ? WORD_BIT : 0) |
    (DIGIT.test(s) ? DIGIT_BIT : 0) |
    (format ? FORMAT_BIT : 0) |
    (continuesCluster ? CONTINUES_CLUSTER_BIT : 0)
  );
}

// Memoized and bounded (clearing it never changes an answer): a document with 500k rejected
// occurrences would otherwise run four regexes each.
const ASCII_CLASS = Array.from({ length: 0x80 }, (_, cp) => classify(cp));
const classCache = new Map<number, number>();
function charClass(cp: number): number {
  if (cp < 0x80) return ASCII_CLASS[cp];
  let bits = classCache.get(cp);
  if (bits === undefined) {
    if (classCache.size >= 65_536) classCache.clear();
    bits = classify(cp);
    classCache.set(cp, bits);
  }
  return bits;
}

const isFormat = (cp: number) => (charClass(cp) & FORMAT_BIT) !== 0;
const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

// "edge": ran into the start/end of the text. "unknown": more invisible characters than we'll skip.
type Neighbour = { cp: number; at: number } | "edge" | "unknown";

function neighbourBefore(text: string, pos: number): Neighbour {
  for (let i = pos, skipped = 0; i > 0; skipped++) {
    if (skipped > MAX_SKIPPED_FORMAT_CHARS) return "unknown";
    const cp = codePointBefore(text, i);
    i -= width(cp);
    if (!isFormat(cp)) return { cp, at: i };
  }
  return "edge";
}

function neighbourAfter(text: string, pos: number): Neighbour {
  for (let i = pos, skipped = 0; i < text.length; skipped++) {
    if (skipped > MAX_SKIPPED_FORMAT_CHARS) return "unknown";
    const cp = text.codePointAt(i)!;
    if (!isFormat(cp)) return { cp, at: i };
    i += width(cp);
  }
  return "edge";
}

const isWord = (n: Neighbour) => typeof n === "object" && (charClass(n.cp) & WORD_BIT) !== 0;
const isDigit = (n: Neighbour) => typeof n === "object" && (charClass(n.cp) & DIGIT_BIT) !== 0;

// Whether a joiner character binds its neighbours into one token: a hyphen, dash or apostrophe between
// two word characters, or a comma, period or slash between two digits. An unknown neighbour binds (fails safe).
function joins(cp: number, beforeIt: Neighbour, afterIt: Neighbour): boolean {
  const isWordJoiner = WORD_JOINERS.has(cp);
  if (!isWordJoiner && !NUMBER_JOINERS.has(cp)) return false;
  if (beforeIt === "unknown" || afterIt === "unknown") return true;
  return isWordJoiner ? isWord(beforeIt) && isWord(afterIt) : isDigit(beforeIt) && isDigit(afterIt);
}

function splitsGraphemeCluster(text: string, pos: number, budget: BoundaryBudget): boolean {
  const previous = codePointBefore(text, pos);
  const next = text.codePointAt(pos)!;
  if (previous < 0x80 && next < 0x80) return previous === 0x0d && next === 0x0a;

  if (isRegionalIndicator(previous) && isRegionalIndicator(next)) {
    // Flags pair up from the start of the run, so the parity of the run before `pos` decides.
    let run = 0;
    for (let i = pos; i >= 2 && isRegionalIndicator(codePointBefore(text, i)); i -= 2) {
      if (++run > MAX_REGIONAL_INDICATOR_RUN) return true;
    }
    return run % 2 === 1;
  }

  if (budget.graphemeChecks <= 0) return true;
  budget.graphemeChecks--;
  // Start at the nearest code point that can't continue a cluster, so the look-behind rules see
  // their whole pattern.
  let start = pos;
  for (let steps = 0; start > 0; steps++) {
    if (steps > MAX_CLUSTER_LOOKBEHIND) return true;
    const cp = codePointBefore(text, start);
    start -= width(cp);
    if ((charClass(cp) & CONTINUES_CLUSTER_BIT) === 0) break;
  }
  const window = text.slice(start, Math.min(text.length, pos + 4));
  return GRAPHEMES.segment(window).containing(pos - start)!.index !== pos - start;
}

/**
 * Whether `pos` in `text` sits on a token boundary rather than mid-token. Looking past up to
 * {@link MAX_SKIPPED_FORMAT_CHARS} invisible format characters (soft hyphen, ZWSP, ZWJ, ZWNJ) on
 * each side, a position is mid-token when: both neighbours are word characters; a neighbour is a
 * hyphen/dash or apostrophe with a word character on both sides of it; a neighbour is "," "." or "/"
 * with a digit on both sides; or the position splits a grapheme cluster (flags, emoji modifiers, ZWJ
 * sequences, Indic conjuncts). Text edges always count as boundaries.
 */
export function isTokenBoundary(text: string, pos: number, budget: BoundaryBudget): boolean {
  if (pos <= 0 || pos >= text.length) return true;
  const left = neighbourBefore(text, pos);
  const right = neighbourAfter(text, pos);
  if (left === "unknown" || right === "unknown") return false;
  if (isWord(left) && isWord(right)) return false;
  if (left !== "edge" && joins(left.cp, neighbourBefore(text, left.at), right)) return false;
  if (right !== "edge" && joins(right.cp, left, neighbourAfter(text, right.at + width(right.cp)))) return false;
  return !splitsGraphemeCluster(text, pos, budget);
}
