/**
 * Deterministic Markdown export for Prepare output — never renders model- or document-derived text
 * through a raw-HTML path. Model-independent: takes only plain data, never an LlmClient or a
 * VerifyResult. Question/checklist item types live here, not in services/prepare.ts (which reuses
 * them), since the deterministic layer sits below the service layer and must not import from it.
 * Every model- or document-derived string is Markdown-escaped before export, and every
 * AI-generated line carries a fixed, renderer-owned prefix a hostile document can never reproduce.
 */

import type { DocumentCategory, VerificationStatus } from "@/server/core/types";
import { sanitizeModelText } from "@/server/deterministic/sanitize/model-text";
import { lensLabelParts } from "@/shared/lens-labels";
import { LEGAL_ADVICE_COPY } from "@/shared/copy/legal-advice";

/**
 * The only per-finding shape this module sees for a citation — never a VerifyResult. `spanText`
 * is the only quote text rendered.
 */
export interface PrepareVerification {
  status: VerificationStatus;
  spanStart: number | null;
  spanEnd: number | null;
  // canonicalText.slice(spanStart, spanEnd), sliced by services/prepare.ts; null only when there's no span.
  spanText: string | null;
  verifierVersion: string;
}

/** A finding cited by a Prepare question or checklist item, or null for a flagged-missing clause. */
export interface PrepareFindingRef {
  id: string;
  category: DocumentCategory;
  verification: PrepareVerification | null;
}

/** A lawyer-prep question the model generated, with the findings it cites. */
export interface PrepareQuestion {
  question: string;
  whyItMatters: string;
  findingIds: string[];
  findings: PrepareFindingRef[];
}

/** A pre-signing checklist item the model generated, with the findings it cites. */
export interface PrepareChecklistItem {
  item: string;
  findingIds: string[];
  findings: PrepareFindingRef[];
}

/** The full Prepare output to render: every question and checklist item. */
export interface PrepareMarkdownOutput {
  lawyerQuestions: readonly PrepareQuestion[];
  checklist: readonly PrepareChecklistItem[];
}

/** The document metadata shown at the top of the export. */
export interface PrepareMarkdownDocument {
  filename: string;
  // Named fields, plain data — this module never imports the service layer's Lens type. Omitted
  // only by a caller with no lens at all (a hand-built export in a test).
  lens?: { role: string; stage: string };
}

// A top-of-document notice only — the per-line prefixes below are what actually stops a per-item forgery.
const AI_GENERATED_NOTICE =
  "The questions and checklist below are AI-generated general information, not verified statements. Only the quoted passage under each one has been checked against your document — the question, explanation and checklist text itself is not verified.";

// Renderer-owned, fixed strings prepended to every question/whyItMatters/item line, never derived
// from model output, so no AI-generated line is ever confusable with a real citation (STATUS_LABEL below).
const AI_QUESTION_PREFIX = "AI-suggested question:";
const AI_WHY_PREFIX = "Why it may matter (AI-generated, not verified):";
const AI_CHECK_PREFIX = "AI-suggested check:";

const STATUS_LABEL: Record<VerificationStatus, string> = {
  verified: "Quote verified against the document",
  approximate: "Quote approximately matches the document — check this wording yourself",
  not_found: "Quote could not be found in the document — treat this claim with caution",
};

const MISSING_CLAUSE_LABEL = "Flagged as possibly missing — not checked against the document";

// CommonMark's escapable ASCII punctuation, backslash-escaped so it can never open a raw HTML tag,
// an entity reference, or a markdown link/image. Built as a Set + for...of rather than a regex
// character class: no risk of a mis-escaped "-"/"]"/"^" inside a class silently narrowing what's caught.
const ESCAPABLE = new Set([
  "!",
  '"',
  "#",
  "$",
  "%",
  "&",
  "'",
  "(",
  ")",
  "*",
  "+",
  ",",
  "-",
  ".",
  "/",
  ":",
  ";",
  "<",
  "=",
  ">",
  "?",
  "@",
  "[",
  "]",
  "^",
  "_",
  "`",
  "{",
  "|",
  "}",
  "~",
  "\\",
]);

/** Backslash-escapes CommonMark's escapable ASCII punctuation in `text`. */
export function escapeMarkdown(text: string): string {
  let out = "";
  for (const ch of text) out += ESCAPABLE.has(ch) ? `\\${ch}` : ch;
  return out;
}

// For model-written and free text only. Collapses whitespace (including newlines) to single spaces
// before escaping: a blank line inside model text would otherwise end the current Markdown list item
// early and leave a dangling `**`/`_`.
function inline(text: string): string {
  return escapeMarkdown(sanitizeModelText(text).replace(/\s+/g, " ").trim());
}

// A span is the document's own text under a verification label, so it is escaped and never
// altered — stripping a glyph or collapsing a space would show a label over text that is not the
// canonical slice. Continuation lines are indented to stay inside the citation's list item.
function quotedSpan(spanText: string): string {
  return escapeMarkdown(spanText).replace(/\n/g, "\n    ");
}

// The only place a verification label may appear, and never receives model text — `category` is a
// server enum and `spanText` is services/prepare.ts's own canonical-text slice.
function renderCitation(ref: PrepareFindingRef): string {
  const category = inline(ref.category);
  const v = ref.verification;
  if (v === null) {
    return `  - _(${category})_ ${MISSING_CLAUSE_LABEL}.`;
  }
  const label = STATUS_LABEL[v.status];
  if (v.spanText === null) {
    return `  - _(${category})_ **${label}.**`;
  }
  return `  - _(${category})_ **${label}:** "${quotedSpan(v.spanText)}"`;
}

function renderQuestion(question: PrepareQuestion): string {
  return [
    `- **${AI_QUESTION_PREFIX}** ${inline(question.question)}`,
    `  **${AI_WHY_PREFIX}** ${inline(question.whyItMatters)}`,
    ...question.findings.map((ref) => renderCitation(ref)),
  ].join("\n");
}

function renderChecklistItem(item: PrepareChecklistItem): string {
  return [`- **${AI_CHECK_PREFIX}** ${inline(item.item)}`, ...item.findings.map((ref) => renderCitation(ref))].join("\n");
}

function preparedForLine(lens: { role: string; stage: string }): string {
  const { role, stage } = lensLabelParts(lens);
  return `Prepared for: ${escapeMarkdown(role)}, ${escapeMarkdown(stage)}`;
}

/** Renders a Prepare output as the full Markdown document shown/exported to the user. */
export function renderPrepareMarkdown(output: PrepareMarkdownOutput, document: PrepareMarkdownDocument): string {
  const questions =
    output.lawyerQuestions.length === 0
      ? "_No questions were generated for this document._"
      : output.lawyerQuestions.map((q) => renderQuestion(q)).join("\n\n");
  const checklist =
    output.checklist.length === 0
      ? "_No checklist items were generated for this document._"
      : output.checklist.map((item) => renderChecklistItem(item)).join("\n\n");

  return [
    "# Prepare for your lawyer",
    "",
    `**${LEGAL_ADVICE_COPY.prepareLead}** ${LEGAL_ADVICE_COPY.prepareDetail}`,
    "",
    AI_GENERATED_NOTICE,
    "",
    `Document: ${inline(document.filename)}`,
    ...(document.lens ? [preparedForLine(document.lens)] : []),
    "",
    "## Questions to ask your lawyer",
    "",
    questions,
    "",
    "## Before you sign / before you meet your lawyer",
    "",
    checklist,
  ].join("\n");
}
