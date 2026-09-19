// Typed loader for the curated live-validation set. The scripts/validate-live/** scripts read
// fixtures through this module, and fixtures.test.ts validates every file through the same schemas,
// so a consumer can never read a shape the structural test did not check.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DOCUMENT_CATEGORIES } from "@/server/core/types";
import { includesWholeWordPhrase } from "@/server/deterministic/detect-type";
import { DOCUMENT_TYPE_IDS } from "@/server/deterministic/document-type-registry";
import { DRAFTABLE_DOCUMENT_TYPE_IDS } from "@/server/deterministic/draft-templates";
import { SPECIALIST_IDS } from "@/server/orchestrator/specialist-registry";

export const LIVE_VALIDATION_DIR = fileURLToPath(new URL(".", import.meta.url));

// THE matching rule for `matchKeywords` and `expectedMentions`: whole-word/whole-phrase and
// case-insensitive, via detect-type's own matcher, so "minors" never matches inside "minor". Every
// consumer calls this — a second, hand-rolled matcher would silently measure something else.
export function matchedPhrases(text: string, phrases: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return phrases.filter((phrase) => includesWholeWordPhrase(lower, phrase.toLowerCase()));
}

const text = z.string().trim().min(1);

const keyEntrySchema = z
  .object({
    id: text,
    category: z.enum(DOCUMENT_CATEGORIES),
    altCategories: z.array(z.enum(DOCUMENT_CATEGORIES)).min(1).optional(),
    required: z.boolean(),
    // Optional entries only: the required entries that carry the same issue. A model quoting this
    // sentence of the issue instead of the carrier's still credits the carrier.
    carriedBy: z.array(text).min(1).optional(),
    description: text,
    // An exact substring of the fixture's canonical text; null only for missing_clause.
    anchor: text.nullable(),
    // missing_clause only: words a model's finding explanation may use for this gap, and phrases
    // whose absence from the fixture proves the clause really is missing.
    matchKeywords: z.array(text).min(1).optional(),
    absentPhrases: z.array(text).min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const missing = entry.category === "missing_clause";
    if (missing !== (entry.anchor === null)) {
      ctx.addIssue({ code: "custom", message: `${entry.id}: anchor must be null exactly when category is missing_clause` });
    }
    if (missing !== (entry.matchKeywords !== undefined && entry.absentPhrases !== undefined)) {
      ctx.addIssue({ code: "custom", message: `${entry.id}: matchKeywords/absentPhrases belong to (and are required on) missing_clause entries only` });
    }
    if (entry.altCategories?.includes(entry.category)) {
      ctx.addIssue({ code: "custom", message: `${entry.id}: altCategories repeats the primary category` });
    }
  });

const keyFileSchema = z.object({ fixture: text, entries: z.array(keyEntrySchema).min(1) }).strict();

const askQuestionSchema = z
  .object({
    id: text,
    kind: z.enum(["grounded", "general", "routing"]),
    attachFixture: z.boolean(),
    question: text,
    // grounded only: verbatim passages of the fixture the answer should rest on.
    expectedAnchors: z.array(text).min(1).optional(),
    expectedSpecialist: z.enum(SPECIALIST_IDS),
    routingAmbiguous: z.boolean(),
    // routingAmbiguous only: every specialist a careful human would accept as the primary route.
    acceptableSpecialists: z.array(z.enum(SPECIALIST_IDS)).min(2).optional(),
    note: text.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    // The routing bar is computed over non-grounded questions only, so "routing" and "general"
    // never attach a document — an attached document's affinity boost would decide the route by
    // itself.
    if ((q.kind === "grounded") !== q.attachFixture) {
      ctx.addIssue({ code: "custom", message: `${q.id}: exactly the grounded questions attach their fixture` });
    }
    if ((q.kind === "grounded") !== (q.expectedAnchors !== undefined)) {
      ctx.addIssue({ code: "custom", message: `${q.id}: exactly the grounded questions carry expectedAnchors` });
    }
    if (q.routingAmbiguous !== (q.acceptableSpecialists !== undefined)) {
      ctx.addIssue({ code: "custom", message: `${q.id}: acceptableSpecialists is set exactly when routingAmbiguous is true` });
    }
    if (q.acceptableSpecialists && !q.acceptableSpecialists.includes(q.expectedSpecialist)) {
      ctx.addIssue({ code: "custom", message: `${q.id}: acceptableSpecialists must include expectedSpecialist` });
    }
  });

const askFileSchema = z.object({ fixture: text, questions: z.array(askQuestionSchema).min(8).max(10) }).strict();

const nonLegalFileSchema = z
  .object({
    questions: z
      .array(z.object({ id: text, question: text, ambiguous: z.boolean(), note: text.optional() }).strict())
      .min(1),
  })
  .strict();

// 1-based line number in its own file; [start, end) character offsets of that full line in the
// file's canonical text (a comparison change's verified span is overlapped with these); the full
// line; and the words that actually changed.
const compareSideSchema = z
  .object({
    line: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text,
    snippet: text,
  })
  .strict();

const compareChangeSchema = z
  .object({
    id: text,
    type: z.enum(["added", "removed", "changed"]),
    description: text,
    before: compareSideSchema.nullable(),
    after: compareSideSchema.nullable(),
    // The model's explanation of this change should contain at least one of these, per
    // matchedPhrases() — evidence it explained the change, not just that the detector found it.
    expectedMentions: z.array(text).min(1),
  })
  .strict()
  .superRefine((change, ctx) => {
    const ok =
      change.type === "added"
        ? change.before === null && change.after !== null
        : change.type === "removed"
          ? change.before !== null && change.after === null
          : change.before !== null && change.after !== null;
    if (!ok) ctx.addIssue({ code: "custom", message: `${change.id}: before/after presence does not match type ${change.type}` });
  });

const comparePairSchema = z
  .object({ id: text, before: text, after: text, changes: z.array(compareChangeSchema).min(2).max(3) })
  .strict();

const draftItemSchema = z
  .object({
    id: text,
    documentType: z.enum(DRAFTABLE_DOCUMENT_TYPE_IDS),
    mode: z.enum(["from_scratch", "document_grounded"]),
    groundingFixture: text.optional(),
    jurisdiction: text,
    userInstructions: text,
    // document_grounded: strings from the grounding fixture a grounded draft should reproduce.
    // from_scratch: strings from userInstructions the draft should carry over (informational).
    expectedFacts: z.array(text).min(1).max(3),
  })
  .strict()
  .superRefine((item, ctx) => {
    if ((item.mode === "document_grounded") !== (item.groundingFixture !== undefined)) {
      ctx.addIssue({ code: "custom", message: `${item.id}: groundingFixture is set exactly when mode is document_grounded` });
    }
  });

const draftFileSchema = z.object({ items: z.array(draftItemSchema).min(1) }).strict();

const indexSchema = z
  .object({
    fixtures: z
      .array(
        z.object({ id: text, expectedDocumentType: z.enum(DOCUMENT_TYPE_IDS), document: text, key: text, ask: text }).strict(),
      )
      .min(1),
    comparePairs: z.array(text).min(1),
    askNonLegal: text,
    draftExpectations: text,
  })
  .strict();

export type KeyEntry = z.infer<typeof keyEntrySchema>;
export type AskQuestion = z.infer<typeof askQuestionSchema>;
export type CompareChange = z.infer<typeof compareChangeSchema>;
export type DraftItem = z.infer<typeof draftItemSchema>;

function readText(relativePath: string): string {
  return readFileSync(`${LIVE_VALIDATION_DIR}${relativePath}`, "utf8");
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath));
}

// Every `text` field below is the fixture file exactly as stored — upload it as text/plain (UTF-8).
// Its canonical_text is the same string without the trailing newline (fixtures.test.ts asserts
// normalizeText leaves each file otherwise untouched), so anchors and line numbers apply unchanged.
export function loadLiveValidationSet() {
  const index = indexSchema.parse(readJson("index.json"));
  return {
    index,
    fixtures: index.fixtures.map((fixture) => ({
      ...fixture,
      text: readText(fixture.document),
      keyFile: keyFileSchema.parse(readJson(fixture.key)),
      askFile: askFileSchema.parse(readJson(fixture.ask)),
    })),
    comparePairs: index.comparePairs.map((file) => {
      const pair = comparePairSchema.parse(readJson(file));
      return { ...pair, file, beforeText: readText(pair.before), afterText: readText(pair.after) };
    }),
    nonLegal: nonLegalFileSchema.parse(readJson(index.askNonLegal)),
    draft: draftFileSchema.parse(readJson(index.draftExpectations)),
  };
}

export type LiveValidationSet = ReturnType<typeof loadLiveValidationSet>;
