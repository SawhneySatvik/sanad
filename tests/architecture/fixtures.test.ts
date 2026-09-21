// Structural gate for the curated live-validation set. Makes no model call — it checks that the
// golden keys, Compare manifests, Ask questions and Draft expectations are internally honest
// against the fixture text and the real registries, so live measurements are not self-graded.

import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_CATEGORIES } from "@/server/core/types";
import { detectDocumentType } from "@/server/deterministic/detect-type";
import { DOCUMENT_TYPE_IDS, DOCUMENT_TYPE_REGISTRY } from "@/server/deterministic/document-type-registry";
import { DRAFTABLE_DOCUMENT_TYPE_IDS } from "@/server/deterministic/draft-templates";
import { normalizeText } from "@/server/deterministic/extract/normalize";
import { MAX_INSTRUCTIONS_CHARS } from "@/server/prompts/draft/prompt";
import { buildUnderstandSystemPrompt } from "@/server/prompts/understand/analyze";
import { LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";
import { MAX_QUERY_CHARS } from "@/server/services/ask";
import { findCandidateChanges } from "@/server/services/compare";
import { LIVE_VALIDATION_DIR, loadLiveValidationSet, matchedPhrases } from "@tests/fixtures/live-validation/load";

const set = loadLiveValidationSet();

// The recall denominators the README quotes (70 required entries in total). Pinned so a key edit
// that changes them fails here until the README's table is updated too.
const REQUIRED_PER_FIXTURE: Record<string, number> = {
  leave_and_license: 14,
  job_offer_letter: 10,
  nda: 11,
  privacy_policy: 13,
  freelance_service_agreement: 10,
  generic: 12,
};

// The routing-bar denominators the README quotes: the bar runs over non-grounded questions only.
const NON_GROUNDED_QUESTIONS = 30;
const NON_GROUNDED_AMBIGUOUS = 3;

// Realistic phrasings of each missing_clause gap as a model explanation might put them — singular,
// plural and variant forms. Each must hit at least one of the entry's matchKeywords through the
// same matcher the live-validation scripts use.
const MISSING_CLAUSE_PROBES: Record<string, string[]> = {
  "LL-16": [
    "There is no list of the furniture and appliances handed over.",
    "No inventory is attached to the agreement.",
    "There is no record of the flat's condition at move-in.",
    "Ask for a move-in inspection report signed by both sides.",
  ],
  "LL-17": ["The agreement does not say which courts have jurisdiction.", "There is no dispute resolution clause."],
  "JO-17": [
    "The offer letter does not mention your leave entitlements.",
    "There is no clause on how many paid leaves you get in a year.",
    "Ask HR for the leave policy before signing.",
    "Nothing says how much time off you get.",
  ],
  "JO-18": ["The letter does not state the governing law.", "No jurisdiction or arbitration clause is included."],
  "ND-12": [
    "There is no exception for disclosure required by law.",
    "Nothing allows disclosure under court orders or to regulators.",
    "You could breach the NDA just by answering a subpoena.",
  ],
  "ND-13": [
    "Information you independently developed is not excluded.",
    "Nothing excludes information received from a third party without restriction.",
  ],
  "PP-16": [
    "The policy says nothing about children's data.",
    "No mention of how data of a minor is handled.",
    "There is no process for parental consent.",
  ],
  "PP-17": ["The policy does not mention your right to nominate someone.", "Nothing is said about nomination."],
  "FS-14": [
    "The contract has no interest or penalty for late payments by the client.",
    "There is no consequence if the Client pays late.",
    "Nothing compensates you for delayed payments.",
    "No late-payment interest is provided.",
  ],
  "FS-15": ["You have no right to suspend work if invoices are unpaid.", "Nothing lets you stop work until you are paid."],
  "GN-15": [
    "There is no refund or credit for internet outages.",
    "The agreement promises no uptime.",
    "No service credits if services fail.",
    "No pro-rata refund if the centre is closed.",
  ],
  "GN-16": ["Nothing explains how CCTV footage is stored or shared.", "There is no privacy clause for visitor data."],
};

// Start offsets of every occurrence, overlapping ones included.
function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i);
  return at;
}

interface DiffLine {
  line: number;
  text: string;
}

// LCS line diff: the lines of `a` outside the longest common subsequence (removed) and the lines of
// `b` outside it (added), each with its 1-based line number in its own file.
function lineDiff(a: string[], b: string[]): { removed: DiffLine[]; added: DiffLine[] } {
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const removed: DiffLine[] = [];
  const added: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j === b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      removed.push({ line: i + 1, text: a[i] });
      i++;
    } else {
      added.push({ line: j + 1, text: b[j] });
      j++;
    }
  }
  return { removed, added };
}

// Character offset where 0-based line `index` starts in text split on "\n".
function lineStart(lines: readonly string[], index: number): number {
  return lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
}

// The Understand prompt text every lens explanation is written through, with the per-type focus
// checklist cut out on purpose — it names the topics to look for, so its words legitimately appear
// in on-topic findings; boilerplate that frames EVERY explanation must not contain a keyword.
function understandBoilerplate(documentType: (typeof DOCUMENT_TYPE_IDS)[number]): string {
  const prompt = buildUnderstandSystemPrompt(documentType);
  const withoutFocus = prompt.replace(/pay particular attention to: .*\n\nCATEGORIES/, "\n\nCATEGORIES");
  if (withoutFocus === prompt) throw new Error("Understand prompt layout changed: update understandBoilerplate()");
  const lenses = LENSES_BY_DOCUMENT_TYPE[documentType].map((lens) => `${lens.id} ${lens.role} ${lens.stage} ${lens.description}`);
  return [withoutFocus, ...lenses].join("\n");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

const PRINTABLE_ASCII = /^[\x20-\x7E\n]*$/;

describe("self-checks: the helpers this gate relies on can fail", () => {
  it("occurrences() counts repeats, overlapping ones included", () => {
    expect(occurrences("abc abc", "abc")).toEqual([0, 4]);
    expect(occurrences("aaa", "aa")).toEqual([0, 1]);
    expect(occurrences("abc", "x")).toEqual([]);
  });

  it("matchedPhrases() matches whole words and phrases only, case-insensitively", () => {
    expect(matchedPhrases("No MINORS allowed", ["minors", "minor"])).toEqual(["minors"]);
    expect(matchedPhrases("contracts", ["contract"])).toEqual([]);
    expect(matchedPhrases("no late-payment interest", ["late-payment", "late payment"])).toEqual(["late-payment"]);
  });

  it("lineDiff() reports a changed, an inserted and a trailing line", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual({
      removed: [{ line: 2, text: "b" }],
      added: [
        { line: 2, text: "x" },
        { line: 4, text: "d" },
      ],
    });
    expect(lineDiff(["a", "b"], ["a", "b"])).toEqual({ removed: [], added: [] });
  });
});

describe("index", () => {
  it("covers the 5 tuned document types plus generic, one fixture each", () => {
    const expected = DOCUMENT_TYPE_IDS.filter((id) => id !== "grounded_response");
    expect(set.fixtures.map((f) => f.expectedDocumentType).sort()).toEqual([...expected].sort());
    expect(duplicates(set.fixtures.map((f) => f.id))).toEqual([]);
  });

  it("every key and question set names its own fixture", () => {
    for (const fixture of set.fixtures) {
      expect(fixture.keyFile.fixture).toBe(fixture.id);
      expect(fixture.askFile.fixture).toBe(fixture.id);
    }
  });

  it("every file in the directory is referenced (no orphaned, unvalidated fixture)", () => {
    const referenced = new Set([
      "index.json",
      "README.md",
      "load.ts",
      "fixtures.test.ts",
      set.index.askNonLegal,
      set.index.draftExpectations,
      ...set.index.comparePairs,
      ...set.fixtures.flatMap((f) => [f.document, f.key, f.ask]),
      ...set.comparePairs.flatMap((p) => [p.before, p.after]),
    ]);
    const onDisk = filesUnder(LIVE_VALIDATION_DIR).map((file) => path.relative(LIVE_VALIDATION_DIR, file).split(path.sep).join("/"));
    expect(onDisk.filter((file) => !referenced.has(file))).toEqual([]);
  });

  it("ids are unique across all keys and all question sets", () => {
    expect(duplicates(set.fixtures.flatMap((f) => f.keyFile.entries.map((e) => e.id)))).toEqual([]);
    expect(
      duplicates([...set.fixtures.flatMap((f) => f.askFile.questions.map((q) => q.id)), ...set.nonLegal.questions.map((q) => q.id)]),
    ).toEqual([]);
  });

  it("the recall denominators are the README's: required entries per fixture, 70 in total", () => {
    expect(Object.fromEntries(set.fixtures.map((f) => [f.id, f.keyFile.entries.filter((e) => e.required).length]))).toEqual(
      REQUIRED_PER_FIXTURE,
    );
    expect(Object.values(REQUIRED_PER_FIXTURE).reduce((sum, n) => sum + n, 0)).toBe(70);
  });

  it("the routing-bar denominators are the README's: non-grounded questions and how many are ambiguous", () => {
    const nonGrounded = set.fixtures.flatMap((f) => f.askFile.questions.filter((q) => q.kind !== "grounded"));
    expect(nonGrounded.length).toBe(NON_GROUNDED_QUESTIONS);
    expect(nonGrounded.filter((q) => q.routingAmbiguous).length).toBe(NON_GROUNDED_AMBIGUOUS);
  });

  it("every missing_clause entry has probe phrasings, and every probe belongs to a real entry", () => {
    const missingIds = set.fixtures.flatMap((f) => f.keyFile.entries.filter((e) => e.category === "missing_clause").map((e) => e.id));
    expect(Object.keys(MISSING_CLAUSE_PROBES).sort()).toEqual(missingIds.sort());
  });
});

for (const fixture of set.fixtures) {
  const canonical = normalizeText(fixture.text);

  describe(`fixture ${fixture.id}`, () => {
    it("is already canonical: normalizeText changes nothing but the trailing newline", () => {
      expect(canonical).toBe(fixture.text.replace(/\n$/, ""));
    });

    it("is printable ASCII, so verify() measures grounding rather than quote typography", () => {
      expect(PRINTABLE_ASCII.test(canonical)).toBe(true);
    });

    it("is a realistic length (1,500-4,000 words)", () => {
      const words = wordCount(canonical);
      expect(words).toBeGreaterThanOrEqual(1500);
      expect(words).toBeLessThanOrEqual(4000);
    });

    it(`detects as ${fixture.expectedDocumentType} through the real detect-type`, () => {
      expect(detectDocumentType(canonical).documentType).toBe(fixture.expectedDocumentType);
    });

    describe("golden key", () => {
      const entries = fixture.keyFile.entries;
      const anchored = entries.filter((e) => e.anchor !== null);
      const missing = entries.filter((e) => e.category === "missing_clause");

      it("has at least one REQUIRED entry in each of the five categories", () => {
        for (const category of DOCUMENT_CATEGORIES) {
          expect(entries.filter((e) => e.category === category && e.required).length, category).toBeGreaterThanOrEqual(1);
        }
      });

      it("carriedBy only on optional entries, and only naming required entries of this key", () => {
        const required = new Set(entries.filter((e) => e.required).map((e) => e.id));
        const wrong = entries
          .filter((e) => e.carriedBy)
          .flatMap((e) => [
            ...(e.required ? [`${e.id} is required`] : []),
            ...e.carriedBy!.filter((id) => !required.has(id)).map((id) => `${e.id} -> ${id} is not a required entry here`),
          ]);
        expect(wrong).toEqual([]);
      });

      it("every anchor occurs exactly once in the canonical text", () => {
        const wrong = anchored
          .map((e) => ({ id: e.id, count: occurrences(canonical, e.anchor!).length }))
          .filter((r) => r.count !== 1);
        expect(wrong).toEqual([]);
      });

      // Distinct spans only. Adjacent anchors can sit a newline and a clause number apart, so a
      // model quote spanning that boundary overlaps both — matching therefore assigns each finding
      // to at most one entry (see this fixture set's README), which this test does not replace.
      it("no two anchors overlap", () => {
        const spans = anchored
          .map((e) => ({ id: e.id, start: canonical.indexOf(e.anchor!), end: canonical.indexOf(e.anchor!) + e.anchor!.length }))
          .sort((a, b) => a.start - b.start);
        const overlapping = spans.filter((span, i) => i > 0 && span.start < spans[i - 1].end).map((span) => span.id);
        expect(overlapping).toEqual([]);
      });

      it("every missing_clause entry's absentPhrases really are absent (substring)", () => {
        const lower = canonical.toLowerCase();
        const present = missing.flatMap((e) =>
          e.absentPhrases!.filter((p) => lower.includes(p.toLowerCase())).map((p) => `${e.id}: ${p}`),
        );
        expect(present).toEqual([]);
      });

      // A word the document itself uses also shows up in explanations of clauses that ARE present,
      // and would inflate missing-clause recall.
      it("no missing_clause matchKeyword occurs anywhere in the fixture", () => {
        const present = missing.flatMap((e) => matchedPhrases(canonical, e.matchKeywords!).map((k) => `${e.id}: ${k}`));
        expect(present).toEqual([]);
      });

      it("no missing_clause matchKeyword occurs in the Understand lens/prompt boilerplate for this type", () => {
        const boilerplate = understandBoilerplate(fixture.expectedDocumentType);
        const present = missing.flatMap((e) => matchedPhrases(boilerplate, e.matchKeywords!).map((k) => `${e.id}: ${k}`));
        expect(present).toEqual([]);
      });

      it("every probe phrasing of a missing clause hits one of its matchKeywords", () => {
        const misses = missing.flatMap((e) =>
          (MISSING_CLAUSE_PROBES[e.id] ?? []).filter((probe) => matchedPhrases(probe, e.matchKeywords!).length === 0).map((probe) => `${e.id}: ${probe}`),
        );
        expect(misses).toEqual([]);
      });
    });

    describe("Ask questions", () => {
      const questions = fixture.askFile.questions;

      it("every grounded question's anchors occur exactly once in the canonical text", () => {
        const wrong = questions.flatMap((q) =>
          (q.expectedAnchors ?? [])
            .map((anchor) => ({ id: q.id, anchor, count: occurrences(canonical, anchor).length }))
            .filter((r) => r.count !== 1),
        );
        expect(wrong).toEqual([]);
      });

      it("has 5 grounded, 2 general and 3 routing questions, each within the Ask length cap", () => {
        expect(questions.filter((q) => q.kind === "grounded").length).toBe(5);
        expect(questions.filter((q) => q.kind === "general").length).toBe(2);
        expect(questions.filter((q) => q.kind === "routing").length).toBe(3);
        for (const q of questions) expect(q.question.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
      });
    });
  });
}

for (const pair of set.comparePairs) {
  const before = normalizeText(pair.beforeText);
  const after = normalizeText(pair.afterText);
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const fixture = set.fixtures.find((f) => f.document === pair.before);

  describe(`compare pair ${pair.id}`, () => {
    it("pairs a curated fixture with a canonical, same-type after version", () => {
      expect(fixture?.id).toBe(pair.id);
      expect(after).toBe(pair.afterText.replace(/\n$/, ""));
      expect(PRINTABLE_ASCII.test(after)).toBe(true);
      expect(detectDocumentType(after).documentType).toBe(fixture?.expectedDocumentType);
    });

    it("every manifest line is that file's actual line at its stated offsets, unique in it, and contains its snippet", () => {
      for (const change of pair.changes) {
        for (const [side, text, lines] of [
          [change.before, before, beforeLines],
          [change.after, after, afterLines],
        ] as const) {
          if (side === null) continue;
          expect(lines[side.line - 1], change.id).toBe(side.text);
          expect(side.start, change.id).toBe(lineStart(lines, side.line - 1));
          expect(text.slice(side.start, side.end), change.id).toBe(side.text);
          expect(lines.filter((line) => line === side.text).length, change.id).toBe(1);
          expect(occurrences(side.text, side.snippet).length, change.id).toBe(1);
        }
      }
    });

    it("a changed line differs only by its snippet", () => {
      for (const change of pair.changes.filter((c) => c.type === "changed")) {
        expect(change.before!.text.replace(change.before!.snippet, change.after!.snippet), change.id).toBe(change.after!.text);
      }
    });

    it("expectedMentions name the change: found in the changed side's line, and for a change never in the old line", () => {
      for (const change of pair.changes) {
        const line = change.type === "removed" ? change.before!.text : change.after!.text;
        expect(matchedPhrases(line, change.expectedMentions).length, change.id).toBeGreaterThanOrEqual(1);
        if (change.type === "changed") expect(matchedPhrases(change.before!.text, change.expectedMentions), change.id).toEqual([]);
      }
    });

    it("the line diff between the two files equals the manifest exactly", () => {
      const byLine = (a: DiffLine, b: DiffLine) => a.line - b.line;
      const expected = {
        removed: pair.changes.flatMap((c) => (c.before ? [{ line: c.before.line, text: c.before.text }] : [])).sort(byLine),
        added: pair.changes.flatMap((c) => (c.after ? [{ line: c.after.line, text: c.after.text }] : [])).sort(byLine),
      };
      expect(lineDiff(beforeLines, afterLines)).toEqual(expected);
    });

    it("Compare's own clause alignment finds exactly the manifest's changes, one candidate each, at the manifest offsets", () => {
      const candidates = findCandidateChanges(before, after);
      expect(candidates.length).toBe(pair.changes.length);
      for (const change of pair.changes) {
        const match = candidates.filter(
          (c) =>
            c.changeType === change.type &&
            (change.before ? c.clauseA?.start === change.before.start && c.clauseA.end === change.before.end : c.clauseA === null) &&
            (change.after ? c.clauseB?.start === change.after.start && c.clauseB.end === change.after.end : c.clauseB === null),
        );
        expect(match.length, change.id).toBe(1);
      }
    });
  });
}

describe("Draft expectations", () => {
  const items = set.draft.items;
  const fixtureText = new Map(set.fixtures.map((f) => [f.id, normalizeText(f.text)]));

  it("has one from_scratch and one document_grounded item per draftable type", () => {
    for (const type of DRAFTABLE_DOCUMENT_TYPE_IDS) {
      for (const mode of ["from_scratch", "document_grounded"] as const) {
        expect(items.filter((i) => i.documentType === type && i.mode === mode).length, `${type} ${mode}`).toBe(1);
      }
    }
  });

  it("uses a jurisdiction the registry supports and fits the instructions cap", () => {
    for (const item of items) {
      const entry = DOCUMENT_TYPE_REGISTRY.find((e) => e.id === item.documentType);
      expect(entry?.jurisdictions, item.id).toContain(item.jurisdiction);
      expect(item.userInstructions.length, item.id).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    }
  });

  it("grounded items: every expected fact is in the grounding fixture and NOT in the instructions", () => {
    for (const item of items.filter((i) => i.mode === "document_grounded")) {
      const grounding = fixtureText.get(item.groundingFixture!);
      expect(grounding, item.id).toBeDefined();
      for (const fact of item.expectedFacts) {
        expect(grounding!.includes(fact), `${item.id}: ${fact} in fixture`).toBe(true);
        expect(item.userInstructions.includes(fact), `${item.id}: ${fact} leaked into instructions`).toBe(false);
      }
    }
  });

  it("from-scratch items: every expected fact comes from the instructions", () => {
    for (const item of items.filter((i) => i.mode === "from_scratch")) {
      for (const fact of item.expectedFacts) expect(item.userInstructions.includes(fact), `${item.id}: ${fact}`).toBe(true);
    }
  });
});

describe("non-legal questions", () => {
  it("each fits the Ask length cap", () => {
    for (const q of set.nonLegal.questions) expect(q.question.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });
});
