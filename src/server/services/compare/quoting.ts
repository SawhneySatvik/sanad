/**
 * Candidate-quote placement: for each side of a candidate change, verify() picks a real, boundary-
 * valid quote from that side's own document — the model's proposed quote when it lands inside the
 * clause, the clause itself (or a context-widened slice of it) otherwise. Also the segmentation-
 * artefact check compare.ts's own write path runs before persisting. Deterministic given verify()'s
 * result: no LLM call of its own.
 */

import type { InputMode } from "../../core/types";
import type { Clause } from "../../deterministic/segment";
import { MAX_QUOTE_CHARS, MAX_QUOTES_PER_CALL, verifyMany, type VerifyResult } from "../../deterministic/verify";
import type { ReadyDocument } from "../../data/comparisons";

// Shared with compare.ts's own sideBinds/shown/clausesOf — one function, both call sites.
export function overlaps(span: { spanStart: number | null; spanEnd: number | null }, clause: Clause): boolean {
  return span.spanStart !== null && span.spanEnd !== null && span.spanStart < clause.end && span.spanEnd > clause.start;
}

/** Below this many non-space characters a text is never dropped as a segmentation artefact — too short to trust a coincidental match. */
const MIN_ARTEFACT_NON_SPACE_CHARS = 12;

// The text a side's own change stands for, for the segmentation-artefact check only: the verified
// span — what verify() actually found in that document — when there is one, since a kept model quote
// or a context-widened clause quote can read differently from the clause itself; otherwise the
// model's own unverified claim, so a change with no placed quote is still checked. Never the clause
// text itself: a change genuinely dropped because nothing verified has no text worth trusting.
function artefactSideText(verification: VerifyResult | null, modelQuote: string | null | undefined, canonicalText: string): string | null {
  if (verification !== null && verification.status !== "not_found") {
    return canonicalText.slice(verification.spanStart, verification.spanEnd);
  }
  return modelQuote ?? null;
}

// Whitespace runs collapsed, case preserved: a paragraph split into several clauses by one file
// format (DOCX: each wrapped line its own clause) against the same text kept as one clause by another
// looks like it moved, not changed, even though the words never left. `collapsedOther` is the other
// document's canonical text, already collapsed once by the caller — documents run to hundreds of
// thousands of characters, so collapsing it again per candidate would be quadratic.
function isSegmentationArtefact(text: string | null, collapsedOther: string): boolean {
  if (text === null) return false;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.replace(/\s/g, "").length < MIN_ARTEFACT_NON_SPACE_CHARS) return false;
  return collapsedOther.includes(collapsed);
}

/** Counts compare() logs (compare_changes_dropped) when it drops a change whose only side's text is still present, unchanged, on the other side. */
export interface DroppedArtefactCounts {
  removedPresent: number;
  addedPresent: number;
}

export interface CandidateSide {
  changeType: "added" | "removed" | "changed";
  clauseA: Clause | null;
  clauseB: Clause | null;
}

// A "removed" or "added" candidate whose only side's text turns out to already be present, verbatim
// once whitespace is normalised, in the other document: findCandidateChanges reported it because its
// clause never anchored to an identical one — most often because a paragraph was split differently by
// the two file formats — not because the words were actually added or removed. "changed" candidates
// already show both sides, so there is nothing to drop.
export function dropSegmentationArtefacts(
  candidates: readonly CandidateSide[],
  answers: readonly ({ quoteA: string | null; quoteB: string | null } | undefined)[],
  sideA: SideQuotes,
  sideB: SideQuotes,
  documentA: ReadyDocument,
  documentB: ReadyDocument,
  collapsedTextA: string,
  collapsedTextB: string,
): { keep: boolean[] } & DroppedArtefactCounts {
  let removedPresent = 0;
  let addedPresent = 0;
  const keep = candidates.map((candidate, i) => {
    if (candidate.changeType === "removed") {
      const text = artefactSideText(sideA.verifications[i], answers[i]?.quoteA, documentA.canonicalText);
      if (isSegmentationArtefact(text, collapsedTextB)) {
        removedPresent++;
        return false;
      }
    } else if (candidate.changeType === "added") {
      const text = artefactSideText(sideB.verifications[i], answers[i]?.quoteB, documentB.canonicalText);
      if (isSegmentationArtefact(text, collapsedTextA)) {
        addedPresent++;
        return false;
      }
    }
    return true;
  });
  return { keep, removedPresent, addedPresent };
}

export interface SideQuotes {
  quotes: (string | null)[];
  verifications: (VerifyResult | null)[];
  kept: number;
  replaced: number;
}

// Every quote must land on its own clause: verify() reports the first boundary-valid occurrence in
// the whole document, so a repeated phrase could otherwise highlight the wrong passage. A model
// quote is kept only if its span lies inside the clause; otherwise the clause itself is quoted.
export function quoteSide(
  clauses: readonly (Clause | null)[],
  modelQuotes: readonly (string | null)[],
  document: ReadyDocument,
): SideQuotes {
  const proposed = clauses.map((clause, i) => {
    const quote = modelQuotes[i];
    return clause !== null && quote !== null && quote.trim() !== "" ? quote : null;
  });
  const proposedResults = verifyQuotes(proposed, document.canonicalText, document.inputMode);
  const kept = proposedResults.map((result, i) => {
    const clause = clauses[i];
    return result !== null && clause !== null && landsWithin(result, clause.start, clause.end);
  });
  const placed = placeClauseQuotes(
    clauses.map((clause, i) => (kept[i] ? null : clause)),
    document,
  );
  return {
    quotes: clauses.map((_, i) => (kept[i] ? proposed[i] : (placed[i]?.quote ?? null))),
    verifications: clauses.map((_, i) => (kept[i] ? proposedResults[i] : (placed[i]?.verification ?? null))),
    kept: kept.filter(Boolean).length,
    replaced: proposed.filter((quote, i) => quote !== null && !kept[i]).length,
  };
}

function landsWithin(result: VerifyResult, start: number, end: number): boolean {
  return result.status !== "not_found" && result.spanStart >= start && result.spanEnd <= end;
}

// A verbatim slice of the canonical text: the quote is exactly text.slice(start, end).
interface Region {
  start: number;
  end: number;
}

// How many words of neighbouring text a clause quote may borrow to tell it apart from an identical
// passage elsewhere — tried in this order, backward first, then forward.
const CONTEXT_WORD_STEPS = [1, 2, 4, 8, 16, 32];

// The clause itself is tried first; if its text also appears earlier, verify() would find that
// copy instead, so the quote borrows a few context words until it's unique to this place — verify()
// has no "search from here", so context is the only way to point at the second copy.
function placeClauseQuotes(
  clauses: readonly (Clause | null)[],
  document: ReadyDocument,
): ({ quote: string; verification: VerifyResult } | null)[] {
  const text = document.canonicalText;
  const attempts = clauses.map((clause) => {
    const own = clause === null ? null : fitRegion(text, clause.start, clause.end, "start");
    return own === null ? [] : [own];
  });
  const placed = verifyRegions(attempts, clauses, document);

  const retries = clauses.map((clause, i) => {
    const own = attempts[i][0];
    return clause === null || placed[i] !== null || own === undefined ? [] : contextRegions(text, own, clause);
  });
  const retried = verifyRegions(retries, clauses, document);
  return placed.map((first, i) => first ?? retried[i]);
}

// For each clause, the first of its regions verify() places inside that very region and on the clause.
function verifyRegions(
  regions: readonly Region[][],
  clauses: readonly (Clause | null)[],
  document: ReadyDocument,
): ({ quote: string; verification: VerifyResult } | null)[] {
  const text = document.canonicalText;
  const flat = regions.flat();
  const results = verifyQuotes(
    flat.map((region) => text.slice(region.start, region.end)),
    text,
    document.inputMode,
  );
  let next = 0;
  return regions.map((own, i) => {
    let found: { quote: string; verification: VerifyResult } | null = null;
    for (const region of own) {
      const result = results[next++]!;
      const clause = clauses[i]!;
      if (found === null && landsWithin(result, region.start, region.end) && overlaps(result, clause)) {
        found = { quote: text.slice(region.start, region.end), verification: result };
      }
    }
    return found;
  });
}

// The clause quote widened by 1, 2, 4 … words of verbatim text before it, then after it.
function contextRegions(text: string, own: Region, clause: Clause): Region[] {
  const regions: Region[] = [];
  const before = wordStartsBefore(text, own.start, CONTEXT_WORD_STEPS.at(-1)!);
  const after = wordEndsAfter(text, own.end, CONTEXT_WORD_STEPS.at(-1)!);
  for (const step of CONTEXT_WORD_STEPS) {
    if (step <= before.length) {
      const region = fitRegion(text, before[step - 1], own.end, "start");
      if (region !== null && region.end > clause.start) regions.push(region);
    }
  }
  for (const step of CONTEXT_WORD_STEPS) {
    if (step <= after.length) {
      const region = fitRegion(text, own.start, after[step - 1], "end");
      if (region !== null && region.start < clause.end) regions.push(region);
    }
  }
  return regions;
}

// text.slice(start, end), shortened at a whitespace boundary to MAX_QUOTE_CHARS — a longer quote is
// not_found by rule even though the text is really there — from the end ("start" is kept) or from
// the start ("end" is kept). null if there is no whitespace to cut at.
function fitRegion(text: string, start: number, end: number, keep: "start" | "end"): Region | null {
  if (end - start <= MAX_QUOTE_CHARS) return { start, end };
  if (keep === "start") {
    let cut = start + MAX_QUOTE_CHARS;
    while (cut > start && !/\s/.test(text[cut])) cut--;
    while (cut > start && /\s/.test(text[cut - 1])) cut--;
    return cut > start ? { start, end: cut } : null;
  }
  let cut = end - MAX_QUOTE_CHARS;
  while (cut < end && !(/\s/.test(text[cut - 1]) && !/\s/.test(text[cut]))) cut++;
  return cut < end ? { start: cut, end } : null;
}

// Offsets where the `count` words before `from` start, nearest first.
function wordStartsBefore(text: string, from: number, count: number): number[] {
  const starts: number[] = [];
  let i = from;
  while (starts.length < count) {
    while (i > 0 && /\s/.test(text[i - 1])) i--;
    if (i === 0) break;
    while (i > 0 && !/\s/.test(text[i - 1])) i--;
    starts.push(i);
  }
  return starts;
}

// Offsets where the `count` words after `from` end, nearest first.
function wordEndsAfter(text: string, from: number, count: number): number[] {
  const ends: number[] = [];
  let i = from;
  while (ends.length < count) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i === text.length) break;
    while (i < text.length && !/\s/.test(text[i])) i++;
    ends.push(i);
  }
  return ends;
}

// verifyMany in chunks of at most MAX_QUOTES_PER_CALL (it throws above that). Position i of
// the result is quote i's; comparisons.ts re-checks each result against its own quote and document,
// so a mismatch fails the write instead of attaching a status to the wrong side or change.
export function verifyQuotes(
  quotes: readonly (string | null)[],
  canonicalText: string,
  inputMode: InputMode,
): (VerifyResult | null)[] {
  const quoted = quotes.filter((quote): quote is string => quote !== null);
  const results: VerifyResult[] = [];
  for (let start = 0; start < quoted.length; start += MAX_QUOTES_PER_CALL) {
    results.push(...verifyMany(quoted.slice(start, start + MAX_QUOTES_PER_CALL), canonicalText, inputMode));
  }
  let next = 0;
  return quotes.map((quote) => (quote === null ? null : results[next++]));
}
