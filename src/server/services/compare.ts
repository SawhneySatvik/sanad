/**
 * Compare service — two documents, clause by clause. Route handlers call compare() or get(), nothing else.
 *
 * Hybrid, so recall does not depend on the model: clause alignment is deterministic, one LLM call
 * only explains the candidate changes it is given, and each side's quote is verified against its
 * own document. A model quote is kept only when verify() finds it inside its own clause; otherwise
 * the clause is quoted instead, so a change is never lost to a model omission or misquote.
 *
 * Clause alignment (findCandidateChanges) lives in ./compare/align.ts, and candidate-quote
 * placement/segmentation-artefact filtering in ./compare/quoting.ts — both deterministic, neither
 * calling the LLM; this file is the model round-trip and the read/write entry points.
 */

import type { Db } from "../../db/client";
import { AppError } from "../core/errors";
import type { Principal } from "../core/types";
import type { Clause } from "../deterministic/segment";
import type { VerifyResult } from "../deterministic/verify";
import { LLM_TIMEOUT_MS, MODEL_INPUT_BUDGET_CHARS } from "../llm/timeouts";
import type { LlmClient } from "../llm/types";
import { buildCompareUserPrompt, COMPARE_SYSTEM_PROMPT, compareResponseSchema, type CompareModelOutput } from "../prompts/compare/compare";
import { createComparison, getComparableDocuments, getComparison, type Comparison, type ComparisonChangeType } from "../data/comparisons";
import { assertBelowActiveRowCap, getDocument, type Document } from "../data/documents";
import { collapse, findCandidateChanges, type CandidateChange } from "./compare/align";
import { dropSegmentationArtefacts, overlaps, quoteSide, verifyQuotes } from "./compare/quoting";

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

// Re-exported so a caller that only needs the deterministic diff (validate-live's own fixtures,
// tests/architecture/fixtures.test.ts) never has to know it now lives in ./compare/align.
export { findCandidateChanges, MAX_ALIGN_CELLS, type CandidateChange } from "./compare/align";
