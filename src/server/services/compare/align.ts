/**
 * Clause alignment — deterministic and model-independent (no DB, no LLM): compare.ts's own
 * candidate-change diff between two documents' clauses. Kept under services/compare rather than
 * src/server/deterministic/** despite being pure text processing: it imports MAX_CHANGES from
 * prompts/compare and ComparisonChangeType from data/comparisons, and the deterministic layer's
 * existing modules (extract, verify, segment, detect-type, draft-templates) never depend on either
 * — adding one dependency here shouldn't be the thing that first blurs that boundary.
 */

import { AppError } from "../../core/errors";
import { clauseMarker, segmentClauses, type Clause } from "../../deterministic/segment";
import { MAX_CHANGES } from "../../prompts/compare/compare";
import type { ComparisonChangeType } from "../../data/comparisons";

/** One clause-level difference the model is asked to explain. */
export interface CandidateChange {
  // c1, c2, … — the only ids the model may reference.
  id: string;
  changeType: ComparisonChangeType;
  clauseA: Clause | null;
  clauseB: Clause | null;
}

/** Bounds the LCS table: (clauses in A) x (clauses in B) after the common prefix and suffix are trimmed. At 4M cells the table is 8 MB and fills in tens of milliseconds. */
export const MAX_ALIGN_CELLS = 4_000_000;

// Word overlap (Jaccard) at or above which two clauses between the same anchors are one clause
// changed; an equal clause number lowers the bar to the second value.
const PAIR_MIN_SIMILARITY = 0.5;
const SAME_NUMBER_MIN_SIMILARITY = 0.25;

interface AlignedClause {
  clause: Clause;
  body: string;
  label: string | null;
  heading: string | null;
  words: Set<string>;
}

// Shared with compare.ts's own top-level segmentation-artefact check (its whitespace-collapsed
// text, not a clause's) — one function, both call sites.
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// The text after the clause marker segment.ts split on ("2.1", "(a)", "Clause 3"), and the marker.
function stripMarker(collapsed: string): { marker: string | null; rest: string } {
  const marker = clauseMarker(collapsed);
  return { marker, rest: marker === null ? collapsed : collapsed.slice(marker.length).trim() };
}

function toAligned(clause: Clause): AlignedClause {
  const { marker, rest: body } = stripMarker(collapse(clause.text));
  const heading = clause.heading === undefined ? "" : stripMarker(collapse(clause.heading)).rest;
  return {
    clause,
    body,
    label: marker?.toLowerCase() ?? null,
    heading: heading === "" ? null : heading,
    words: new Set(body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  };
}

function tooDifferent(): AppError {
  return new AppError("VALIDATION_FAILED", "The documents are too long or too different to compare clause by clause.");
}

// Index pairs [i, j] of clauses with equal bodies, increasing in both.
function anchorPairs(a: readonly AlignedClause[], b: readonly AlignedClause[]): [number, number][] {
  const ids = new Map<string, number>();
  const idOf = (clause: AlignedClause) => {
    if (!ids.has(clause.body)) ids.set(clause.body, ids.size);
    return ids.get(clause.body)!;
  };
  const x = a.map(idOf);
  const y = b.map(idOf);

  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  let endA = x.length;
  let endB = y.length;
  while (endA > prefix && endB > prefix && x[endA - 1] === y[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - prefix;
  const m = endB - prefix;
  if (n * m > MAX_ALIGN_CELLS) throw tooDifferent();

  // lcs[i * width + j] = LCS length of x[prefix + i, endA) and y[prefix + j, endB). Fits Uint16:
  // it is at most min(n, m), and n * m <= MAX_ALIGN_CELLS keeps that under 2,001.
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        x[prefix + i] === y[prefix + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const pairs: [number, number][] = [];
  for (let k = 0; k < prefix; k++) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[prefix + i] === y[prefix + j]) {
      pairs.push([prefix + i, prefix + j]);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  for (let k = 0; k < x.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

// The clauses between two anchors → [A side, B side] pairs; null on the side a clause is absent from.
function pairGap(a: readonly AlignedClause[], b: readonly AlignedClause[]): [AlignedClause | null, AlignedClause | null][] {
  if (a.length === 1 && b.length === 1) return [[a[0], b[0]]];
  const options: { i: number; j: number; sameHeading: boolean; sameLabel: boolean; similarity: number }[] = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const sameHeading = a[i].heading !== null && a[i].heading === b[j].heading;
      const sameLabel = a[i].label !== null && a[i].label === b[j].label;
      const similarity = jaccard(a[i].words, b[j].words);
      if (sameHeading || similarity >= PAIR_MIN_SIMILARITY || (sameLabel && similarity >= SAME_NUMBER_MIN_SIMILARITY)) {
        options.push({ i, j, sameHeading, sameLabel, similarity });
      }
    }
  }
  options.sort(
    (p, q) =>
      Number(q.sameHeading) - Number(p.sameHeading) ||
      q.similarity - p.similarity ||
      Number(q.sameLabel) - Number(p.sameLabel) ||
      p.i - q.i ||
      p.j - q.j,
  );
  const partnerOf = new Map<number, number>();
  const pairedB = new Set<number>();
  for (const option of options) {
    if (partnerOf.has(option.i) || pairedB.has(option.j)) continue;
    partnerOf.set(option.i, option.j);
    pairedB.add(option.j);
  }
  return [
    ...a.map((clause, i): [AlignedClause, AlignedClause | null] => [clause, partnerOf.has(i) ? b[partnerOf.get(i)!] : null]),
    ...b.filter((_, j) => !pairedB.has(j)).map((clause): [null, AlignedClause] => [null, clause]),
  ];
}

/**
 * Every clause-level difference between two canonical texts, in document order (within the stretch
 * between two unchanged clauses: A's clauses first, then clauses only in B). More than MAX_CHANGES
 * is a typed VALIDATION_FAILED, raised before any prompt is built.
 *
 * Alignment is deterministic and model-independent:
 * 1. Each clause is reduced to its body: the leading clause marker ("2.1", "(a)", "Clause 3")
 *    stripped and whitespace collapsed. Two clauses with equal bodies are the same clause, so
 *    renumbering (a clause inserted above shifts every number below it) and re-wrapped lines are
 *    not changes.
 * 2. The longest common subsequence of bodies anchors the unchanged clauses, in order.
 * 3. Between two anchors, the leftover clauses are paired as "changed": a lone clause on each side
 *    always pairs (it sits in the same place); otherwise by the same first line (segment.ts's
 *    heading), then word overlap, with an equal clause number only as a tie-breaker (numbers
 *    shift). The rest are "removed" (only in A) or "added" (only in B).
 */
export function findCandidateChanges(textA: string, textB: string): CandidateChange[] {
  const a = segmentClauses(textA).map(toAligned);
  const b = segmentClauses(textB).map(toAligned);
  const anchors = anchorPairs(a, b);
  // Each change consumes at most two unanchored clauses: above this there must be too many.
  if (a.length + b.length - 2 * anchors.length > 2 * MAX_CHANGES) throw tooDifferent();

  const pairs: [AlignedClause | null, AlignedClause | null][] = [];
  let nextA = 0;
  let nextB = 0;
  for (const [i, j] of [...anchors, [a.length, b.length] as const]) {
    pairs.push(...pairGap(a.slice(nextA, i), b.slice(nextB, j)));
    nextA = i + 1;
    nextB = j + 1;
  }
  if (pairs.length > MAX_CHANGES) throw tooDifferent();

  return pairs.map(([clauseA, clauseB], k) => ({
    id: `c${k + 1}`,
    changeType: clauseA && clauseB ? "changed" : clauseA ? "removed" : "added",
    clauseA: clauseA?.clause ?? null,
    clauseB: clauseB?.clause ?? null,
  }));
}
