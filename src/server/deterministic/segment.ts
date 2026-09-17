/**
 * Deterministic, heuristic clause segmentation, no LLM — Compare aligns two documents clause by
 * clause on its output.
 */

/** A clause's offsets into canonical text, its text, and its optional heading. */
export interface Clause {
  index: number;
  heading?: string;
  start: number;
  end: number;
  text: string;
}

// Matches a numbered clause opener ("1. ", "2) ", "1.1 "): a top-level number needs a trailing
// separator (so "30 days notice" isn't mistaken for one). Each digit group caps at 3 digits, so a
// wrapped statute year like "1999." at a line's start isn't mistaken for one either.
const NUMBERED_RE = /^(?:\d{1,3}(?:\.\d{1,3})+[.)]?|\d{1,3}[.)])(\s|$)/;
// Matches a lettered/roman sub-clause marker: "(a)", "(iv)", "(A)".
const LETTERED_RE = /^\(([a-zA-Z]{1,4})\)(\s|$)/;
// Matches "Clause 3", "Section 4", "ARTICLE II" (roman numeral or digits).
const KEYWORD_RE = /^(clause|section|article)\s+([ivxlcdm]+|\d+)\b/i;

// A first line longer than this is prose, not a heading — legal clause headings are short by convention.
const MAX_HEADING_LENGTH = 100;

function isMarkerLine(trimmed: string): boolean {
  return NUMBERED_RE.test(trimmed) || LETTERED_RE.test(trimmed) || KEYWORD_RE.test(trimmed);
}

/**
 * The marker a line opens with ("1.1", "(a)", "Clause 3"), or null — the same patterns
 * {@link segmentClauses} splits on.
 */
export function clauseMarker(line: string): string | null {
  const trimmed = line.trimStart();
  const match = NUMBERED_RE.exec(trimmed) ?? LETTERED_RE.exec(trimmed) ?? KEYWORD_RE.exec(trimmed);
  return match === null ? null : match[0].trimEnd();
}

// Character offsets where a marked clause begins, at the marker's first non-whitespace character.
function findMarkerBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && isMarkerLine(trimmed)) {
      boundaries.push(offset + (line.length - line.trimStart().length));
    }
    offset += line.length + 1; // +1 accounts for the "\n" split() consumed
  }
  return boundaries;
}

function firstNonWhitespaceStart(text: string, from: number, upTo: number): number | null {
  let start = from;
  while (start < upTo && /\s/.test(text[start])) start++;
  return start < upTo ? start : null;
}

function lastNonWhitespaceEnd(text: string, from: number, upTo: number): number {
  let end = Math.min(upTo, text.length);
  while (end > from && /\s/.test(text[end - 1])) end--;
  return end;
}

// Splits [from, upTo) into paragraph-start offsets on blank-line boundaries — used only for the
// preamble before the first marker, or the whole document when it has no markers at all.
function findParagraphBoundaries(text: string, from: number, upTo: number): number[] {
  const boundaries: number[] = [];
  const blankLineRe = /\n[ \t]*\n+/g;
  blankLineRe.lastIndex = from;
  let paragraphStart = from;
  let match: RegExpExecArray | null;
  while ((match = blankLineRe.exec(text)) !== null && match.index < upTo) {
    const start = firstNonWhitespaceStart(text, paragraphStart, match.index);
    if (start !== null) boundaries.push(start);
    paragraphStart = match.index + match[0].length;
    blankLineRe.lastIndex = paragraphStart;
  }
  const start = firstNonWhitespaceStart(text, paragraphStart, upTo);
  if (start !== null) boundaries.push(start);
  return boundaries;
}

// A clause's heading is its own first line, when short and the clause has more content after it.
function extractHeading(text: string, start: number, end: number): string | undefined {
  const newlineIdx = text.indexOf("\n", start);
  const firstLineEnd = newlineIdx === -1 || newlineIdx >= end ? end : newlineIdx;
  if (firstLineEnd >= end) return undefined;
  const firstLine = text.slice(start, firstLineEnd).trim();
  if (firstLine.length === 0 || firstLine.length > MAX_HEADING_LENGTH) return undefined;
  return firstLine;
}

/**
 * Splits a document's canonical text into clauses: numbered/lettered/keyword-marked clauses each
 * span from their own marker to the next, and any unmarked preamble (or the whole document, if it
 * has no markers) splits into blank-line-separated paragraphs instead. For every returned clause,
 * `clause.text === canonicalText.slice(clause.start, clause.end)` by construction, and consecutive
 * clauses never overlap. Known limitation: a decimal quantity ("3.5 kg of X") is indistinguishable
 * from sub-clause numbering and is treated as a boundary.
 */
export function segmentClauses(canonicalText: string): Clause[] {
  if (canonicalText.length === 0) return [];

  const markerBoundaries = [...new Set(findMarkerBoundaries(canonicalText))].sort((a, b) => a - b);

  const boundaries = new Set<number>(markerBoundaries);
  const preambleEnd = markerBoundaries.length > 0 ? markerBoundaries[0] : canonicalText.length;
  for (const b of findParagraphBoundaries(canonicalText, 0, preambleEnd)) {
    boundaries.add(b);
  }

  const sorted = [...boundaries].sort((a, b) => a - b);

  const clauses: Clause[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const nextBoundary = i + 1 < sorted.length ? sorted[i + 1] : canonicalText.length;
    const end = lastNonWhitespaceEnd(canonicalText, start, nextBoundary);
    if (end <= start) continue; // defensive — boundaries are built from non-whitespace starts
    clauses.push({
      index: clauses.length,
      heading: extractHeading(canonicalText, start, end),
      start,
      end,
      text: canonicalText.slice(start, end),
    });
  }

  return clauses;
}
