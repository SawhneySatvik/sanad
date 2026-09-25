/**
 * Compare service — two documents, clause by clause. Route handlers call compare() or get(), nothing else.
 *
 * Hybrid, so recall does not depend on the model: clause alignment is deterministic, one LLM call
 * only explains the candidate changes it is given, and each side's quote is verified against its
 * own document. A model quote is kept only when verify() finds it inside its own clause; otherwise
 * the clause is quoted instead, so a change is never lost to a model omission or misquote.
 */

import type { Db } from "../../db/client";
import { AppError } from "../core/errors";
import type { InputMode, Principal } from "../core/types";
import { clauseMarker, segmentClauses, type Clause } from "../deterministic/segment";
import { MAX_QUOTE_CHARS, MAX_QUOTES_PER_CALL, verifyMany, type VerifyResult } from "../deterministic/verify";
import { LLM_TIMEOUT_MS, MODEL_INPUT_BUDGET_CHARS } from "../llm/timeouts";
import type { LlmClient } from "../llm/types";
import {
  buildCompareUserPrompt,
  COMPARE_SYSTEM_PROMPT,
  compareResponseSchema,
  MAX_CHANGES,
  type CompareModelOutput,
} from "../prompts/compare/compare";
import {
  createComparison,
  getComparableDocuments,
  getComparison,
  type Comparison,
  type ComparisonChangeType,
  type ReadyDocument,
} from "../data/comparisons";
import { assertBelowActiveRowCap, getDocument, type Document } from "../data/documents";

/** Dependencies compare() needs; get() uses only `db`. */
export interface CompareDeps {
  db: Db;
  llm: LlmClient;
}

/** Input to compare(): the two documents to align. */
export interface CompareInput {
  documentAId: string;
  documentBId: string;
}

/** One aligned change, with each side's quote freshly verified against its own document. */
export interface ComparisonChangeResult {
  id: string;
  changeType: ComparisonChangeType;
  explanation: string;
  explanationProvenance: "ai_generated" | "templated";
  // null on the side the clause is absent from.
  quoteA: string | null;
  quoteB: string | null;
  // verify() run by this very call against documentA's / documentB's current canonical_text.
  // Render documentA.canonicalText.slice(spanStart, spanEnd) (resp. B), never the quote.
  verificationA: VerifyResult | null;
  verificationB: VerifyResult | null;
}

/** compare()'s and get()'s common return shape: the comparison, both documents and every change. */
export interface ComparisonResult {
  comparison: Comparison;
  documentA: Document;
  documentB: Document;
  changes: ComparisonChangeResult[];
}

/** comparisons.model_used when no model was called (identical documents): the sentinel value. */
export const NO_MODEL_USED = "none";

/** compare()'s own return shape: ComparisonResult plus this run's model-quote stats. */
export interface CompareRunResult extends ComparisonResult {
  // Model quotes kept (found inside their own clause) vs replaced by the clause — for live
  // validation of how well the model quotes.
  modelQuotes: { kept: number; replaced: number };
}

/**
 * Aligns two documents' clauses, has one LLM call explain the candidate changes, verifies each
 * side's quote against its own document, and persists the comparison and its changes in one short
 * transaction after the call — no connection or transaction spans the LLM round-trip. The model
 * that explained the changes is persisted and returned by get(), so a fallback-model comparison
 * never looks like a primary-model one.
 *
 * @example
 * const result = await compare(deps, principal, { documentAId, documentBId });
 */
export async function compare(deps: CompareDeps, principal: Principal, input: CompareInput): Promise<CompareRunResult> {
  // Case-insensitive: Postgres reads an upper-case uuid as the same id.
  if (input.documentAId.toLowerCase() === input.documentBId.toLowerCase()) {
    throw new AppError("VALIDATION_FAILED", "Choose two different documents to compare.");
  }
  const { documentA, documentB } = await getComparableDocuments(deps.db, principal, input.documentAId, input.documentBId);
  // createComparison enforces the cap after the model call; checked first too, so a principal at
  // the cap spends no call.
  await assertBelowActiveRowCap(deps.db, principal, "comparisons");
  const candidates = findCandidateChanges(documentA.canonicalText, documentB.canonicalText);

  let modelUsed = NO_MODEL_USED;
  let answers = new Map<string, ModelAnswer>();
  // Identical documents cost no LLM call.
  if (candidates.length > 0) {
    const userPrompt = buildCompareUserPrompt(
      candidates.map((candidate) => ({
        id: candidate.id,
        changeType: candidate.changeType,
        textA: candidate.clauseA?.text ?? null,
        textB: candidate.clauseB?.text ?? null,
      })),
    );
    if (userPrompt.length > MODEL_INPUT_BUDGET_CHARS.compare) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The changed clauses are too long to explain in one comparison: ${userPrompt.length} characters, over the ${MODEL_INPUT_BUDGET_CHARS.compare}-character limit.`,
      );
    }
    const result = await deps.llm.complete({
      systemPrompt: COMPARE_SYSTEM_PROMPT,
      userPrompt,
      schema: compareResponseSchema,
      timeoutMs: LLM_TIMEOUT_MS.compare,
    });
    modelUsed = result.modelUsed;
    answers = answersById(result.data);
  }

  const answerFor = candidates.map((candidate) => answers.get(candidate.id));
  const sideA = quoteSide(
    candidates.map((candidate) => candidate.clauseA),
    answerFor.map((answer) => answer?.quoteA ?? null),
    documentA,
  );
  const sideB = quoteSide(
    candidates.map((candidate) => candidate.clauseB),
    answerFor.map((answer) => answer?.quoteB ?? null),
    documentB,
  );

  const artefacts = dropSegmentationArtefacts(
    candidates,
    answerFor,
    sideA,
    sideB,
    documentA,
    documentB,
    collapse(documentA.canonicalText),
    collapse(documentB.canonicalText),
  );
  if (artefacts.removedPresent + artefacts.addedPresent > 0) {
    // Counts only, never quote text.
    console.warn(
      JSON.stringify({
        event: "compare_changes_dropped",
        surface: "compare",
        removedPresent: artefacts.removedPresent,
        addedPresent: artefacts.addedPresent,
      }),
    );
  }

  const created = await createComparison(deps.db, principal, {
    documentAId: documentA.id,
    documentBId: documentB.id,
    modelUsed,
    changes: candidates
      .map((candidate, i) => ({
        changeType: candidate.changeType,
        explanation: explanationFor(candidate.changeType, answerFor[i]),
        quoteA: sideA.quotes[i],
        verificationA: sideA.verifications[i],
        quoteB: sideB.quotes[i],
        verificationB: sideB.verifications[i],
      }))
      .filter((_, i) => artefacts.keep[i]),
  });

  return {
    ...(await get(deps, principal, created.comparison.id)),
    modelQuotes: { kept: sideA.kept + sideB.kept, replaced: sideA.replaced + sideB.replaced },
  };
}

/**
 * The comparison with its changes. Stored verification statuses and spans are audit fields only:
 * each side is verified again, here, against its own document's current canonical_text, and only
 * that result is returned. Both documents are read through the canAccess chokepoint too.
 *
 * The same containment rule as the write path applies: a side is shown only if its fresh span
 * lands on its own clause, rebuilt from the live texts, so a verifier change can never move a
 * highlight onto another copy of the text. A side whose span falls outside the clause is withheld
 * (no quote, no status).
 */
export async function get(deps: CompareDeps, principal: Principal, comparisonId: string): Promise<ComparisonResult> {
  const { comparison, changes } = await getComparison(deps.db, principal, comparisonId);
  const documentA = await getDocument(deps.db, principal, comparison.documentAId);
  const documentB = await getDocument(deps.db, principal, comparison.documentBId);
  // Changes only exist for ready documents; if that ever failed to hold, an empty text makes every
  // quote not_found rather than anything stronger.
  const textA = documentA.canonicalText ?? "";
  const textB = documentB.canonicalText ?? "";
  const verificationsA = verifyQuotes(
    changes.map((change) => change.quoteTextA),
    textA,
    documentA.inputMode ?? "native_document",
  );
  const verificationsB = verifyQuotes(
    changes.map((change) => change.quoteTextB),
    textB,
    documentB.inputMode ?? "native_document",
  );
  const clauses = clausesOf(textA, textB, changes, verificationsA, verificationsB);

  return {
    comparison,
    documentA,
    documentB,
    changes: changes.map((change, i) => {
      const a = shown(change.quoteTextA, verificationsA[i], clauses?.[i].clauseA);
      const b = shown(change.quoteTextB, verificationsB[i], clauses?.[i].clauseB);
      return {
        id: change.id,
        changeType: change.changeType,
        explanation: change.explanation,
        explanationProvenance: change.explanation === FALLBACK_EXPLANATION[change.changeType] ? "templated" : "ai_generated",
        quoteA: a.quote,
        quoteB: b.quote,
        verificationA: a.verification,
        verificationB: b.verification,
      };
    }),
  };
}

// Each stored change's clauses, rebuilt from the live texts: compare() may have dropped some
// "removed"/"added" candidates as segmentation artefacts, so a stored change is no longer
// necessarily candidate i. Each change is bound instead to the next live candidate of the same
// type whose own fresh verification — the same one that gates display — lands on that candidate's
// clause. A "changed" candidate is never dropped at write time, so one that cannot be bound this
// way means the documents no longer segment the way this comparison was made against; every quote
// is then withheld rather than shown at a place that was never checked.
function clausesOf(
  textA: string,
  textB: string,
  changes: readonly { changeType: ComparisonChangeType }[],
  verificationsA: readonly (VerifyResult | null)[],
  verificationsB: readonly (VerifyResult | null)[],
): CandidateChange[] | null {
  let candidates: CandidateChange[];
  try {
    candidates = findCandidateChanges(textA, textB);
  } catch (error) {
    if (error instanceof AppError) return null;
    throw error;
  }

  const bound: CandidateChange[] = [];
  let next = 0;
  for (let i = 0; i < changes.length; i++) {
    let matched: CandidateChange | undefined;
    while (next < candidates.length) {
      const candidate = candidates[next];
      next++;
      if (
        candidate.changeType === changes[i].changeType &&
        sideBinds(verificationsA[i], candidate.clauseA) &&
        sideBinds(verificationsB[i], candidate.clauseB)
      ) {
        matched = candidate;
        break;
      }
      // Only a "removed"/"added" candidate compare() could have dropped may be skipped this way.
      if (candidate.changeType === "changed") return null;
    }
    if (matched === undefined) return null;
    bound.push(matched);
  }
  return bound;
}

// Vacuous (nothing to check) when there is no found span on this side, so it never disqualifies a
// candidate; otherwise the span must land on the candidate's own clause — the same rule shown()
// applies before displaying it.
function sideBinds(verification: VerifyResult | null, clause: Clause | null): boolean {
  if (verification === null || verification.status === "not_found") return true;
  return clause !== null && overlaps(verification, clause);
}

// `clause` undefined: it could not be located. A not_found result has no span to misplace.
function shown(quote: string | null, verification: VerifyResult | null, clause: Clause | null | undefined) {
  if (quote === null || verification === null || clause === undefined) return { quote: null, verification: null };
  if (verification.status !== "not_found" && (clause === null || !overlaps(verification, clause))) {
    return { quote: null, verification: null };
  }
  return { quote, verification };
}

function overlaps(span: { spanStart: number | null; spanEnd: number | null }, clause: Clause): boolean {
  return span.spanStart !== null && span.spanEnd !== null && span.spanStart < clause.end && span.spanEnd > clause.start;
}

type ModelAnswer = CompareModelOutput["changes"][number];

// The first answer for an id wins. Answers are only ever looked up by a candidate's own id, so one
// for an id this call never supplied is dropped.
function answersById(output: CompareModelOutput): Map<string, ModelAnswer> {
  const answers = new Map<string, ModelAnswer>();
  for (const answer of output.changes) {
    if (!answers.has(answer.id)) answers.set(answer.id, answer);
  }
  return answers;
}

const FALLBACK_EXPLANATION: Record<ComparisonChangeType, string> = {
  added: "This clause appears only in the second document.",
  removed: "This clause appears only in the first document.",
  changed: "The wording of this clause differs between the two documents.",
};

function explanationFor(changeType: ComparisonChangeType, answer: ModelAnswer | undefined): string {
  const explanation = answer?.explanation.trim() ?? "";
  return explanation === "" ? FALLBACK_EXPLANATION[changeType] : explanation;
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
  const collapsed = collapse(text);
  if (collapsed.replace(/\s/g, "").length < MIN_ARTEFACT_NON_SPACE_CHARS) return false;
  return collapsedOther.includes(collapsed);
}

/** Counts compare() logs (compare_changes_dropped) when it drops a change whose only side's text is still present, unchanged, on the other side. */
interface DroppedArtefactCounts {
  removedPresent: number;
  addedPresent: number;
}

// A "removed" or "added" candidate whose only side's text turns out to already be present, verbatim
// once whitespace is normalised, in the other document: findCandidateChanges reported it because its
// clause never anchored to an identical one — most often because a paragraph was split differently by
// the two file formats — not because the words were actually added or removed. "changed" candidates
// already show both sides, so there is nothing to drop.
function dropSegmentationArtefacts(
  candidates: readonly CandidateChange[],
  answers: readonly (ModelAnswer | undefined)[],
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

interface SideQuotes {
  quotes: (string | null)[];
  verifications: (VerifyResult | null)[];
  kept: number;
  replaced: number;
}

// Every quote must land on its own clause: verify() reports the first boundary-valid occurrence in
// the whole document, so a repeated phrase could otherwise highlight the wrong passage. A model
// quote is kept only if its span lies inside the clause; otherwise the clause itself is quoted.
function quoteSide(
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
function verifyQuotes(
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

// Clause alignment below is deterministic and model-independent — see findCandidateChanges.

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

function collapse(text: string): string {
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
