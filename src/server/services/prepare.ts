/**
 * Prepare service: turns a document's already-verified findings into lawyer-prep output — questions
 * to ask a lawyer, a checklist, and a deterministic Markdown export — written for one reader lens
 * (role x stage). Route handlers call generate(), nothing else.
 *
 * Findings come only from Understand's get(); "not_analyzed" and "no_grounded_findings" are typed
 * results, never an empty checklist. Nothing here is persisted, and no connection spans the LLM call.
 */

import { AppError } from "../core/errors";
import type { Principal } from "../core/types";
import {
  type PrepareChecklistItem,
  type PrepareFindingRef,
  type PrepareQuestion,
  renderPrepareMarkdown,
} from "../deterministic/prepare-export/markdown";
import { DOCUMENT_TYPE_IDS, type DocumentTypeId } from "../deterministic/document-type-registry";
import type { Document } from "../data/documents";
import { LLM_TIMEOUT_MS, MODEL_INPUT_BUDGET_CHARS } from "../llm/timeouts";
import {
  buildPrepareResponseSchema,
  buildPrepareSystemPrompt,
  buildPrepareUserPrompt,
  MAX_CHECKLIST_ITEMS,
  MAX_FINDING_IDS_PER_ITEM,
  MAX_LAWYER_QUESTIONS,
  PROMPT_VERSION,
  type PromptFinding,
} from "../prompts/prepare/prepare";
import { LENSES_BY_DOCUMENT_TYPE, type Lens } from "../prompts/understand/lenses";
import { get, type UnderstandDeps, type UnderstandFinding } from "./understand";

export type { PrepareChecklistItem, PrepareFindingRef, PrepareQuestion };

/**
 * Identical shape to UnderstandDeps: generate() calls Understand's get() as its only source of
 * findings, and get()'s own parameter type requires storage/modelId even though generate() itself
 * never touches storage and reuses `llm` for its own call too. The composition root wires one
 * object and passes it to both services.
 */
export type PrepareDeps = UnderstandDeps;

/** generate()'s "complete" result: the lawyer-prep output plus its Markdown export. */
export interface PrepareGenerated {
  state: "complete";
  document: Document;
  // The reader this output was written for — the caller's lensId, resolved against this document's
  // own type, or that type's first lens if none was given.
  lens: Lens;
  // Never both empty — see the SCHEMA_FAILED throw in generate() below.
  lawyerQuestions: PrepareQuestion[];
  checklist: PrepareChecklistItem[];
  modelUsed: string;
  promptVersion: string;
  markdown: string;
  // What trimming dropped from the model's response. Internal metadata for live-validation
  // reports — prepareView picks named fields, so it never reaches the wire. Optional only so a
  // hand-built result (a view test) need not invent counts; generate() always sets it.
  dropped?: PrepareDropped;
}

/**
 * Per list: entries grounded to no offered finding, entries left blank once aliases were scrubbed,
 * repeats of an earlier entry's normalized text, and entries past the business cap.
 * findingIdsOverCap: ids cut from kept entries past MAX_FINDING_IDS_PER_ITEM.
 */
export interface PrepareDropped {
  lawyerQuestions: EntriesDropped;
  checklist: EntriesDropped;
  findingIdsOverCap: number;
}

/** Counts of what keepEntries() dropped from one list, by reason. */
export interface EntriesDropped {
  ungrounded: number;
  blank: number;
  duplicate: number;
  overCap: number;
}

/**
 * Every document with no analysis yet, per get()'s own UnderstandResult: never an empty checklist,
 * which would be indistinguishable from "analysed, nothing to prepare".
 */
export interface PrepareNotAnalyzed {
  state: "not_analyzed";
  document: Document;
}

/**
 * Every finding in this document is either not_found or an unquoted non-missing_clause claim —
 * there is nothing grounded to offer the model at all. Distinct from "complete" with empty lists
 * (which never happens, see above) and distinct from "not_analyzed" (this document was analyzed;
 * analysis just produced nothing Prepare can build on). No LLM call is made for this state.
 */
export interface PrepareNoGroundedFindings {
  state: "no_grounded_findings";
  document: Document;
}

/** generate()'s return type: complete, not yet analyzed, or analyzed with nothing to ground on. */
export type PrepareResult = PrepareGenerated | PrepareNotAnalyzed | PrepareNoGroundedFindings;

/**
 * Exported for tests only: lets a test compute the exact same eligible-findings set (and therefore
 * the exact same F1/F2/… alias numbering) generate() will use, without duplicating this filter.
 */
export function eligibleFindings(findings: readonly UnderstandFinding[]): UnderstandFinding[] {
  return findings.filter((finding) => isEligible(finding));
}

/**
 * Generates lawyer-prep output for an already-analyzed document, written for one reader lens. Only
 * findings get() has just confirmed are grounded are offered to the model at all — a not_found
 * claim, or any finding with no quote to verify other than a missing_clause, is never handed to the
 * model as material, and its id is never accepted back from the model either. Every status/span on
 * an output item is copied from this call's own get() result, never re-verified separately or read
 * from the model.
 *
 * @param lensId One of this document's own type's lens ids (LENSES_BY_DOCUMENT_TYPE); omitted uses
 * that type's first lens, the same default Understand itself uses for a finding's own explanation.
 * @throws AppError VALIDATION_FAILED when lensId names no lens of this document's type. Checked
 * only after get()'s own ownership check, so a foreign document's type is never revealed through
 * whether a lens id is valid for it.
 * @example
 * const result = await generate(deps, principal, documentId);
 */
export async function generate(deps: PrepareDeps, principal: Principal, documentId: string, lensId?: string): Promise<PrepareResult> {
  const understood = await get(deps, principal, documentId);
  const lenses = LENSES_BY_DOCUMENT_TYPE[toDocumentTypeId(understood.document.documentType)];
  const lens = lensId === undefined ? lenses[0] : lenses.find((candidate) => candidate.id === lensId);
  if (lens === undefined) {
    throw new AppError("VALIDATION_FAILED", `"${lensId}" is not a lens of this document's type.`);
  }

  if (understood.analysisState !== "complete") {
    return { state: "not_analyzed", document: understood.document };
  }

  const canonicalText = understood.document.canonicalText ?? "";
  const eligible = eligibleFindings(understood.findings);

  if (eligible.length === 0) {
    return { state: "no_grounded_findings", document: understood.document };
  }

  // Short per-call aliases, never the findings' real UUIDs — the public result's findingIds are
  // always real ids; aliases never leave this module. An alias the model invents, mistypes, or
  // garbles simply isn't in this map, and is dropped by groundedFindings exactly like an unknown id.
  const findingByAlias = new Map(eligible.map((finding, i) => [`F${i + 1}`, finding] as const));
  const promptFindings: PromptFinding[] = eligible.map((finding, i) => ({
    id: `F${i + 1}`,
    category: finding.category,
    quote: quoteFor(finding, canonicalText),
    explanation: explanationFor(finding, lens),
  }));

  const userPrompt = buildPrepareUserPrompt(promptFindings);
  if (userPrompt.length > MODEL_INPUT_BUDGET_CHARS.prepare) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `The document's findings are too long to prepare from: ${userPrompt.length} characters, over the ${MODEL_INPUT_BUDGET_CHARS.prepare}-character limit.`,
      { reason: "too_large" },
    );
  }
  const { data: output, modelUsed } = await deps.llm.complete({
    systemPrompt: buildPrepareSystemPrompt(lens),
    userPrompt,
    schema: buildPrepareResponseSchema(lens.stage),
    timeoutMs: LLM_TIMEOUT_MS.prepare,
  });

  const aliases = new Set(findingByAlias.keys());
  const questions = keepEntries(
    output.lawyerQuestions.map((entry) => ({
      question: scrubAliases(entry.question, aliases),
      whyItMatters: scrubAliases(entry.whyItMatters, aliases),
      ...groundedFindings(entry.findingIds, findingByAlias),
    })),
    (entry) => [entry.question, entry.whyItMatters],
    MAX_LAWYER_QUESTIONS,
  );
  const items = keepEntries(
    output.checklist.map((entry) => ({ item: scrubAliases(entry.item, aliases), ...groundedFindings(entry.findingIds, findingByAlias) })),
    (entry) => [entry.item],
    MAX_CHECKLIST_ITEMS,
  );
  const lawyerQuestions: PrepareQuestion[] = questions.kept.map((entry) => toQuestion(entry, canonicalText));
  const checklist: PrepareChecklistItem[] = items.kept.map((entry) => toChecklistItem(entry, canonicalText));

  const dropped: PrepareDropped = {
    lawyerQuestions: questions.dropped,
    checklist: items.dropped,
    findingIdsOverCap: [...questions.kept, ...items.kept].reduce((sum, entry) => sum + entry.idsOverCap, 0),
  };
  const droppedCount = [dropped.lawyerQuestions, dropped.checklist].reduce(
    (sum, d) => sum + d.ungrounded + d.blank + d.duplicate + d.overCap,
    dropped.findingIdsOverCap,
  );
  if (droppedCount > 0) {
    // Counts only, never question or item text.
    console.warn(JSON.stringify({ event: "llm_output_trimmed", surface: "prepare", documentId, modelUsed, ...dropped }));
  }

  if (lawyerQuestions.length === 0 && checklist.length === 0) {
    // There were eligible findings (unlike "no_grounded_findings" above); every alias the model
    // returned was invented, foreign, or duplicated down to nothing. SCHEMA_FAILED so a caller's
    // retry path never silently reports success on a response that produced nothing usable.
    throw new AppError("SCHEMA_FAILED", "The model's response didn't ground to any of this document's findings.");
  }

  return {
    state: "complete",
    document: understood.document,
    lens,
    lawyerQuestions,
    checklist,
    modelUsed,
    promptVersion: PROMPT_VERSION,
    markdown: renderPrepareMarkdown(
      { lawyerQuestions, checklist },
      { filename: understood.document.filename, lens: { role: lens.role, stage: lens.stage } },
    ),
    dropped,
  };
}

// Mirrors understand.ts's own private fallback exactly (same DOCUMENT_TYPE_IDS list, same "generic"
// default for an unrecognized or not-yet-detected value) — Prepare must never pick a different
// document type, and therefore a different lens set, than the analysis it is building on.
function toDocumentTypeId(value: string | null): DocumentTypeId {
  return DOCUMENT_TYPE_IDS.find((id) => id === value) ?? "generic";
}

// Falls back to the finding's default explanation when this lens has none — always true for a
// checklist gap (lensExplanations: []), and defensively for a model finding too.
function explanationFor(finding: UnderstandFinding, lens: Lens): string {
  return finding.lensExplanations.find((entry) => entry.lens === lens.id)?.explanation ?? finding.explanation;
}

// Grounded entries only, then non-blank (the schema's check ran before the alias scrub, which can
// empty an item like "(F2)"), then the first of each normalized text (a repeat in different case
// or spacing), then the business cap — counting what each step drops.
function keepEntries<Entry extends { grounded: UnderstandFinding[] }>(
  entries: Entry[],
  textsOf: (entry: Entry) => string[],
  cap: number,
): { kept: Entry[]; dropped: EntriesDropped } {
  const grounded = entries.filter((entry) => entry.grounded.length > 0);
  const nonBlank = grounded.filter((entry) => textsOf(entry).every((text) => text.trim() !== ""));
  const seen = new Set<string>();
  const unique = nonBlank.filter((entry) => {
    const key = textsOf(entry)[0].trim().replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const kept = unique.slice(0, cap);
  return {
    kept,
    dropped: {
      ungrounded: entries.length - grounded.length,
      blank: grounded.length - nonBlank.length,
      duplicate: nonBlank.length - unique.length,
      overCap: unique.length - kept.length,
    },
  };
}

// Live model answers have cited aliases ("(F1)", "as stated in F11") in reader-visible text, where
// they mean nothing; the prompt forbids it, and every alias this call offered is scrubbed out here
// (findingIds keeps the real mapping). Never applied to a quote or spanText, which may contain "F1".
const ALIAS_TOKEN = /\bF\d+\b/g;
// "(F1)", "(F1, F2)", "(see F3 and F4)", "(finding F5)": a parenthetical holding nothing but aliases.
const ALIAS_PARENTHETICAL = /\s*\(\s*(?:see\s+)?(?:[Ff]indings?\s+)?F\d+(?:\s*(?:,|&|\/|\band\b|\bor\b)\s*F\d+)*\s*\)/g;
// "F11", "F3 and F4", "finding F2", "findings F1, F2" in running text.
const ALIAS_RUN = /\b(?:[Ff]indings?\s+)?F\d+\b(?:\s*(?:,|&|\/|\band\b|\bor\b)\s*F\d+\b)*/g;

function scrubAliases(text: string, aliases: ReadonlySet<string>): string {
  const offered = (match: string) => (match.match(ALIAS_TOKEN) ?? []).every((token) => aliases.has(token));
  return text
    // Collapsed first: the patterns below start with \s* or \s+, which rescan a long whitespace run
    // from every position in it — quadratic in the run's length.
    .replace(/\s{2,}/g, " ")
    .replace(ALIAS_PARENTHETICAL, (match) => (offered(match) ? "" : match))
    .replace(ALIAS_RUN, (match, offset: number, whole: string) => {
      if (!offered(match)) return match;
      const plural = (match.match(ALIAS_TOKEN) ?? []).length > 1 || /^findings/i.test(match);
      const words = plural ? "the linked findings" : "the linked finding";
      // Only the few characters before the alias: whitespace runs are collapsed above, and testing
      // the whole prefix for every alias was quadratic in alias-dense text.
      const startsSentence = offset === 0 || /[.!?]\s+$/.test(whole.slice(Math.max(0, offset - 3), offset));
      return startsSentence ? words[0].toUpperCase() + words.slice(1) : words;
    })
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Eligible only when there's something server-verified to point to: a non-not_found quote, or a
// missing_clause (verification === null by construction, nothing to verify). Any other category
// with verification === null is an unquoted claim Understand accepted — as ungrounded as not_found.
function isEligible(finding: UnderstandFinding): boolean {
  if (finding.verification === null) return finding.category === "missing_clause";
  return finding.verification.status !== "not_found";
}

// The exact document text to ground the model in: the verified span, never the original,
// possibly-approximate claim. null for a missing_clause and, defensively, for a not_found finding
// (that check also lets TypeScript narrow spanStart/spanEnd to `number`).
function quoteFor(finding: UnderstandFinding, canonicalText: string): string | null {
  const verification = finding.verification;
  if (verification === null || verification.status === "not_found") return null;
  return canonicalText.slice(verification.spanStart, verification.spanEnd);
}

// Resolves this item's model-returned aliases back to real findings: drops any invented or
// never-offered alias, and de-duplicates before capping — a model repeating one alias never eats
// into MAX_FINDING_IDS_PER_ITEM for no reason. The schema itself carries no array cap (Gemini rejects it).
function groundedFindings(
  aliases: readonly string[],
  findingByAlias: ReadonlyMap<string, UnderstandFinding>,
): { grounded: UnderstandFinding[]; idsOverCap: number } {
  const seen = new Set<string>();
  const kept: UnderstandFinding[] = [];
  for (const alias of aliases) {
    const finding = findingByAlias.get(alias);
    if (finding !== undefined && !seen.has(alias)) {
      seen.add(alias);
      kept.push(finding);
    }
  }
  return { grounded: kept.slice(0, MAX_FINDING_IDS_PER_ITEM), idsOverCap: Math.max(0, kept.length - MAX_FINDING_IDS_PER_ITEM) };
}

// The public shape carries a server-sliced spanText, never a whole VerifyResult and never a second
// copy of the model's claimed quote.
function toFindingRef(finding: UnderstandFinding, canonicalText: string): PrepareFindingRef {
  const v = finding.verification;
  return {
    id: finding.id,
    category: finding.category,
    verification:
      v === null
        ? null
        : {
            status: v.status,
            spanStart: v.spanStart,
            spanEnd: v.spanEnd,
            spanText: v.status === "not_found" ? null : canonicalText.slice(v.spanStart, v.spanEnd),
            verifierVersion: v.verifierVersion,
          },
  };
}

function toQuestion(entry: { question: string; whyItMatters: string; grounded: UnderstandFinding[] }, canonicalText: string): PrepareQuestion {
  return {
    question: entry.question,
    whyItMatters: entry.whyItMatters,
    findingIds: entry.grounded.map((finding) => finding.id),
    findings: entry.grounded.map((finding) => toFindingRef(finding, canonicalText)),
  };
}

function toChecklistItem(entry: { item: string; grounded: UnderstandFinding[] }, canonicalText: string): PrepareChecklistItem {
  return {
    item: entry.item,
    findingIds: entry.grounded.map((finding) => finding.id),
    findings: entry.grounded.map((finding) => toFindingRef(finding, canonicalText)),
  };
}
