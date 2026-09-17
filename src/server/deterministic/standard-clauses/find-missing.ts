/**
 * Deterministic absence detection, no LLM: which standard protections for a document's type have no
 * matching wording anywhere in its canonical text. Conservative by design — a false "missing" claim
 * is misinformation, a missed gap is only a missed hint — so an item is absent only when none of its
 * phrases occurs, and text the matcher cannot judge (an excerpt, over the size cap, largely not
 * English) yields no gaps at all. A gap quotes nothing, so it is never verified.
 */

import { includesWholeWordPhrase } from "../detect-type";
import type { DocumentTypeId } from "../document-type-registry";
import { MAX_EXTRACTED_CHARS } from "../extract/constants";
import { STANDARD_CLAUSES_BY_DOCUMENT_TYPE, STANDARD_CLAUSES_VERSION } from "./checklists";
import type { StandardClauseGap, StandardClauseItem } from "./types";

/** Below this many words the text is treated as an excerpt, whose gaps say nothing about the whole document. */
export const MIN_WORDS = 150;

/** Above this share of non-ASCII letters, a protection may be written in a script the English phrases cannot match. */
export const MAX_NON_ASCII_LETTER_SHARE = 0.1;

// Built from code points: the ligatures PDF extraction leaves inside words ("conﬁdential").
const LIGATURES = new Map([
  [0xfb00, "ff"],
  [0xfb01, "fi"],
  [0xfb02, "fl"],
  [0xfb03, "ffi"],
  [0xfb04, "ffl"],
  [0xfb05, "st"],
  [0xfb06, "st"],
]);
const LIGATURE_RE = new RegExp(`[${[...LIGATURES.keys()].map((cp) => String.fromCharCode(cp)).join("")}]`, "g");

// Invisible characters that can split a word, and apostrophes, so "month's" and "months'" read as "months".
const DROPPED_CODEPOINTS = [0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x27, 0x60, 0xb4, 0x2018, 0x2019, 0x2bc];
const DROPPED_RE = new RegExp(`[${DROPPED_CODEPOINTS.map((cp) => String.fromCharCode(cp)).join("")}]`, "g");

const LINE_END_HYPHEN_RE = /([A-Za-z])-\n[ \t]*([A-Za-z])/g;

const NUMBER_WORDS = new Set(
  (
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen " +
    "eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred"
  ).split(" "),
);

// Every number becomes "0", so a phrase written with one number matches any other. Plurals fold to
// one form: both sides of every comparison pass through here, so the form need not be a real word.
function foldToken(token: string): string {
  if (/^\d+$/.test(token) || NUMBER_WORDS.has(token)) return "0";
  if (token.length <= 3) return token;
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

// Lowercase folded words separated by single spaces: punctuation, hyphens and line breaks all become
// word boundaries, so "Lock-in" matches "lock in".
function toMatchText(text: string): string {
  return text
    .replace(LIGATURE_RE, (ligature) => LIGATURES.get(ligature.charCodeAt(0)) ?? ligature)
    .replace(DROPPED_RE, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "")
    .map(foldToken)
    .join(" ");
}

function nonAsciiLetterShare(text: string): number {
  const letters = text.replace(/\P{L}+/gu, "").length;
  const asciiLetters = text.replace(/[^A-Za-z]+/g, "").length;
  return letters === 0 ? 0 : (letters - asciiLetters) / letters;
}

// The views of the text to search, or null when the text cannot support an absence claim.
function searchableTexts(text: string): string[] | null {
  if (nonAsciiLetterShare(text) > MAX_NON_ASCII_LETTER_SHARE) return null;
  const matchText = toMatchText(text);
  if (matchText.split(" ").length < MIN_WORDS) return null;
  // A word hyphenated across a line break ("main-\ntenance") is also searched joined back up.
  const joined = text.replace(LINE_END_HYPHEN_RE, "$1$2");
  return joined === text ? [matchText] : [matchText, toMatchText(joined)];
}

const ALL_ITEMS = Object.entries(STANDARD_CLAUSES_BY_DOCUMENT_TYPE).flatMap(([documentType, items]) =>
  items.map((item) => ({ gapId: `${documentType}.${item.id}`, item })),
);
const PRESENCE_BY_ITEM = new Map(ALL_ITEMS.map(({ item }) => [item, item.presence.map(toMatchText)]));

interface Topic {
  gapId: string;
  keywordGroups: string[][];
}
// Every gap id → its own document type's topics, so a sentence can be checked against its siblings.
const SIBLING_TOPICS_BY_GAP_ID = new Map(
  Object.entries(STANDARD_CLAUSES_BY_DOCUMENT_TYPE).flatMap(([documentType, items]) => {
    const topics: Topic[] = items.map((item) => ({
      gapId: `${documentType}.${item.id}`,
      keywordGroups: item.topicKeywords.map((group) => group.map(toMatchText)),
    }));
    return topics.map((topic) => [topic.gapId, topics] as const);
  }),
);

// When in doubt the checklist gap stays: a duplicate costs little, a hidden gap hides a missing
// protection. So a sentence (in toMatchText's folded words, where "doesn't" is "doesnt") claims an
// absence only when it holds exactly one negator and that negator opens one of two phrases:
// - a reporting verb right after it, or after "appear to", "fail to" and the like: "does not say",
//   "not mentioned", "fails to specify" — but not "does not just mention";
// - "no" naming a part of the document within two words: "no clause", "no specific provision",
//   "No notice period is stated" — but not "no doubt", "no later than" or "Clause No. 5".
// A second negator anywhere could turn the claim around ("nothing is missing", "is not, in fact,
// missing"), and bare absence words ("missing", "lacks") without a negator are too easy to negate
// at a distance, so neither ever counts.
const NEGATORS = new Set(
  "not no never nothing none nor neither without cannot cant isnt arent wasnt werent doesnt dont didnt fail".split(" ").map(toMatchText),
);
const REPORTING_STEMS = "say said specif mention state stipulat includ address provid cover contain defin set clarif explain deal give list refer spell indicat describ detail".split(" ");
// Words that may sit between the negator and its reporting verb without changing what it says.
const BRIDGE_WORDS = new Set("appear appears seem seems to clearly expressly explicitly specifically even".split(" ").map(toMatchText));
const DOCUMENT_PARTS = new Set(
  "clause provision term section mention reference detail timeline date deadline period schedule statement wording stipulation".split(" ").map(toMatchText),
);

function claimsAbsence(sentence: string): boolean {
  const words = sentence.split(" ");
  const negators = words.flatMap((word, i) => (NEGATORS.has(word) ? [i] : []));
  if (negators.length !== 1) return false;
  const [at] = negators;
  let next = at + 1;
  while (next < words.length && BRIDGE_WORDS.has(words[next])) next++;
  if (next < words.length && REPORTING_STEMS.some((stem) => words[next].startsWith(stem))) return true;
  return words[at] === "no" && words.slice(at + 1, at + 3).some((word) => DOCUMENT_PARTS.has(word));
}

// End punctuation followed by whitespace, or a line break. An abbreviation ("Rs. 500") splits a
// sentence early, which can only keep a gap, never drop one.
const SENTENCE_BREAK_RE = /(?<=[.!?;])\s+|\n+/;

function isPresent(item: StandardClauseItem, texts: readonly string[]): boolean {
  const phrases = PRESENCE_BY_ITEM.get(item) ?? [];
  return phrases.some((phrase) => texts.some((text) => includesWholeWordPhrase(text, phrase)));
}

/**
 * The standard protections for `documentType` that have no matching wording anywhere in
 * `canonicalText`, in checklist order. Pure and deterministic. Returns [] for a type with no
 * checklist (generic, grounded_response), for text over the extraction size cap, and for text too
 * short or too little English to judge.
 *
 * @example
 * const gaps = findMissingStandardClauses(document.documentType, document.canonicalText);
 */
export function findMissingStandardClauses(documentType: DocumentTypeId, canonicalText: string): StandardClauseGap[] {
  const items = STANDARD_CLAUSES_BY_DOCUMENT_TYPE[documentType];
  // Checked before any other work. Truncating instead would claim absent anything in the cut part.
  if (items.length === 0 || canonicalText.length > MAX_EXTRACTED_CHARS) return [];
  const texts = searchableTexts(canonicalText);
  if (texts === null) return [];
  return items
    .filter((item) => !isPresent(item, texts))
    .map((item) => ({
      id: `${documentType}.${item.id}`,
      category: "missing_clause",
      quote: null,
      verification: null,
      topic: item.topic,
      explanation: item.explanation,
      provenance: "standard_clause_checklist",
      checklistVersion: STANDARD_CLAUSES_VERSION,
    }));
}

function namesTopic(sentence: string, topic: Topic): boolean {
  return topic.keywordGroups.some((group) => group.every((keyword) => includesWholeWordPhrase(sentence, keyword)));
}

// The sentence claims an absence and names this gap's topic and no other topic of its checklist.
function reportsOnlyThisGap(sentence: string, gapId: string): boolean {
  const named = (SIBLING_TOPICS_BY_GAP_ID.get(gapId) ?? []).filter((topic) => namesTopic(sentence, topic));
  return named.length === 1 && named[0].gapId === gapId;
}

/**
 * `gaps` without those a model-written missing_clause already reports. Callers pass only the
 * explanations of the model's missing_clause findings, which are absence claims by category. A gap
 * is dropped only when one sentence of such an explanation claims an absence in a strong form with
 * no other negator ("does not say …", "there is no clause on …"), contains every keyword of one of
 * the gap's topic groups, and names no other topic on the same checklist. Anything less certain keeps the gap: model text can be steered by the
 * document, and a duplicate is better than a hidden gap.
 */
export function withoutModelCoveredGaps(
  gaps: readonly StandardClauseGap[],
  modelMissingClauseExplanations: readonly string[],
): StandardClauseGap[] {
  const absenceSentences = modelMissingClauseExplanations
    .flatMap((explanation) => explanation.split(SENTENCE_BREAK_RE))
    .map(toMatchText)
    .filter(claimsAbsence);
  return gaps.filter((gap) => !absenceSentences.some((sentence) => reportsOnlyThisGap(sentence, gap.id)));
}
