// This part's live-validation measurement, matching model findings to golden-key entries (required
// first, larger overlap wins) and reporting an unmatched share as an informational precision signal,
// as tests/fixtures/live-validation/README.md's Understand section describes. Pure: findings (as
// Understand's get() returned them) + the golden key + the canonical text in, numbers out — no
// model, no database, so a saved run can be re-measured.

import { DOCUMENT_CATEGORIES } from "@/server/core/types";
import { matchedPhrases, type KeyEntry } from "../../tests/fixtures/live-validation/load";

export const VERIFIED_RATE_THRESHOLD = 0.9;
export const RECALL_THRESHOLD = 0.8;

export interface MeasuredFinding {
  id: string;
  category: string;
  // null: the finding carries no quote (missing_clause, or a blank quote the service dropped).
  status: "verified" | "approximate" | "not_found" | null;
  spanStart: number | null;
  spanEnd: number | null;
  lensExplanations: { lens: string; explanation: string }[];
}

interface Pair {
  findingIndex: number;
  entryIndex: number;
  required: boolean;
  kind: "anchored" | "missing_clause";
  overlap: number;
  keywords: string[];
}

export interface Assignment {
  findingId: string;
  entryId: string;
  required: boolean;
  kind: "anchored" | "missing_clause";
  overlap: number;
  keywords: string[];
  categoryAgrees: boolean;
}

export interface MissingClauseFinding {
  findingId: string;
  // Every missing-clause entry its explanations hit, with the keywords that hit — assigned or not.
  matches: { entryId: string; keywords: string[] }[];
  assignedTo: string | null;
}

export interface UnderstandMetrics {
  findings: number;
  claimedQuotes: number;
  verified: number;
  approximate: number;
  notFound: number;
  verifiedRate: number | null;
  // Non-missing_clause findings with no quote at all: not a claimed quote, so outside the verified
  // rate's denominator, but ungrounded.
  unquotedNonMissing: number;
  categoryCounts: Record<string, number>;
  outOfEnum: number;
  requiredTotal: number;
  requiredAssigned: string[];
  // Required entries credited because a finding was assigned to an optional entry they carry.
  requiredCarried: { entryId: string; via: string }[];
  requiredHit: number;
  recall: number;
  optionalAssigned: string[];
  missedRequired: string[];
  assignments: Assignment[];
  unmatchedFindingIds: string[];
  duplicateFindingIds: string[];
  unmatchedShare: number | null;
  categoryAgreement: { agree: number; total: number };
  missingClauseFindings: MissingClauseFinding[];
  // Missed required anchors that an `approximate` span overlaps — shown, never credited.
  nearMisses: { entryId: string; findingId: string }[];
}

export function anchorSpan(canonicalText: string, anchor: string): { start: number; end: number } {
  const start = canonicalText.indexOf(anchor);
  // fixtures.test.ts asserts each anchor occurs exactly once; if not, the text measured against is
  // not the fixture's canonical text and every number below would be wrong.
  if (start === -1 || canonicalText.indexOf(anchor, start + 1) !== -1) {
    throw new Error(`anchor does not occur exactly once in the canonical text: ${anchor.slice(0, 60)}`);
  }
  return { start, end: start + anchor.length };
}

function overlapOf(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function keywordHits(finding: MeasuredFinding, keywords: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const { explanation } of finding.lensExplanations) {
    for (const phrase of matchedPhrases(explanation, keywords)) hits.add(phrase);
  }
  return [...hits];
}

export function measureUnderstand(
  canonicalText: string,
  entries: readonly KeyEntry[],
  findings: readonly MeasuredFinding[],
): UnderstandMetrics {
  const spans = entries.map((entry) => (entry.anchor === null ? null : anchorSpan(canonicalText, entry.anchor)));

  const pairs: Pair[] = [];
  findings.forEach((finding, findingIndex) => {
    entries.forEach((entry, entryIndex) => {
      const span = spans[entryIndex];
      if (span !== null) {
        if (finding.status !== "verified" || finding.spanStart === null || finding.spanEnd === null) return;
        const overlap = overlapOf(finding.spanStart, finding.spanEnd, span.start, span.end);
        if (overlap > 0) pairs.push({ findingIndex, entryIndex, required: entry.required, kind: "anchored", overlap, keywords: [] });
        return;
      }
      if (finding.category !== "missing_clause") return;
      const keywords = keywordHits(finding, entry.matchKeywords ?? []);
      if (keywords.length > 0) pairs.push({ findingIndex, entryIndex, required: entry.required, kind: "missing_clause", overlap: 0, keywords });
    });
  });

  // README: required entries first, then larger overlap; missing-clause pairs after anchored ones in
  // the same tier. The index tie-break only makes the greedy walk deterministic.
  pairs.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      Number(a.kind === "missing_clause") - Number(b.kind === "missing_clause") ||
      b.overlap - a.overlap ||
      a.findingIndex - b.findingIndex ||
      a.entryIndex - b.entryIndex,
  );

  const takenFindings = new Set<number>();
  const takenEntries = new Set<number>();
  const accepted: Pair[] = [];
  for (const pair of pairs) {
    if (takenFindings.has(pair.findingIndex) || takenEntries.has(pair.entryIndex)) continue;
    takenFindings.add(pair.findingIndex);
    takenEntries.add(pair.entryIndex);
    accepted.push(pair);
  }

  const assignments: Assignment[] = accepted.map((pair) => {
    const entry = entries[pair.entryIndex];
    const finding = findings[pair.findingIndex];
    return {
      findingId: finding.id,
      entryId: entry.id,
      required: entry.required,
      kind: pair.kind,
      overlap: pair.overlap,
      keywords: pair.keywords,
      categoryAgrees: finding.category === entry.category || (entry.altCategories ?? []).some((c) => c === finding.category),
    };
  });

  const assignedEntryIds = new Set(assignments.map((a) => a.entryId));
  // After the walk: every required pair has been considered by now (they sort first), so a carrier
  // still unassigned here can no longer be assigned.
  const requiredCarried: { entryId: string; via: string }[] = [];
  for (const assignment of assignments) {
    const entry = entries.find((e) => e.id === assignment.entryId);
    for (const carrier of entry?.carriedBy ?? []) {
      if (!assignedEntryIds.has(carrier) && !requiredCarried.some((c) => c.entryId === carrier)) {
        requiredCarried.push({ entryId: carrier, via: entry!.id });
      }
    }
  }

  const required = entries.filter((entry) => entry.required);
  const requiredIds = new Set(required.map((entry) => entry.id));
  const requiredAssigned = assignments.filter((a) => a.required).map((a) => a.entryId);
  // fixtures.test.ts asserts every carrier is required; the filter keeps recall honest if one isn't.
  const credited = new Set([...requiredAssigned, ...requiredCarried.map((c) => c.entryId)].filter((id) => requiredIds.has(id)));
  const missedRequired = required.filter((entry) => !credited.has(entry.id)).map((entry) => entry.id);

  const pairedFindings = new Set(pairs.map((pair) => pair.findingIndex));
  const unmatchedFindingIds = findings.filter((_, i) => !pairedFindings.has(i)).map((f) => f.id);
  const duplicateFindingIds = findings.filter((_, i) => pairedFindings.has(i) && !takenFindings.has(i)).map((f) => f.id);

  const quoted = findings.filter((f) => f.status !== null);
  const verified = quoted.filter((f) => f.status === "verified").length;
  const categoryCounts: Record<string, number> = {};
  for (const finding of findings) categoryCounts[finding.category] = (categoryCounts[finding.category] ?? 0) + 1;
  const known: readonly string[] = DOCUMENT_CATEGORIES;

  const missingClauseFindings: MissingClauseFinding[] = findings
    .map((finding, i) => ({ finding, i }))
    .filter(({ finding }) => finding.category === "missing_clause")
    .map(({ finding, i }) => ({
      findingId: finding.id,
      matches: pairs
        .filter((pair) => pair.findingIndex === i && pair.kind === "missing_clause")
        .sort((a, b) => a.entryIndex - b.entryIndex)
        .map((pair) => ({ entryId: entries[pair.entryIndex].id, keywords: pair.keywords })),
      assignedTo: assignments.find((a) => a.findingId === finding.id)?.entryId ?? null,
    }));

  const nearMisses: { entryId: string; findingId: string }[] = [];
  for (const entryId of missedRequired) {
    const index = entries.findIndex((e) => e.id === entryId);
    const span = spans[index];
    if (span === null) continue;
    for (const finding of findings) {
      if (finding.status !== "approximate" || finding.spanStart === null || finding.spanEnd === null) continue;
      if (overlapOf(finding.spanStart, finding.spanEnd, span.start, span.end) > 0) nearMisses.push({ entryId, findingId: finding.id });
    }
  }

  return {
    findings: findings.length,
    claimedQuotes: quoted.length,
    verified,
    approximate: quoted.filter((f) => f.status === "approximate").length,
    notFound: quoted.filter((f) => f.status === "not_found").length,
    verifiedRate: quoted.length === 0 ? null : verified / quoted.length,
    unquotedNonMissing: findings.filter((f) => f.status === null && f.category !== "missing_clause").length,
    categoryCounts,
    outOfEnum: findings.filter((f) => !known.includes(f.category)).length,
    requiredTotal: required.length,
    requiredAssigned,
    requiredCarried,
    requiredHit: credited.size,
    recall: credited.size / required.length,
    optionalAssigned: assignments.filter((a) => !a.required).map((a) => a.entryId),
    missedRequired,
    assignments,
    unmatchedFindingIds,
    duplicateFindingIds,
    unmatchedShare: findings.length === 0 ? null : unmatchedFindingIds.length / findings.length,
    categoryAgreement: { agree: assignments.filter((a) => a.categoryAgrees).length, total: assignments.length },
    missingClauseFindings,
    nearMisses,
  };
}

// ---------------------------------------------------------------------------------------------
// The deterministic standard-clause checklist, measured on its own
// ---------------------------------------------------------------------------------------------

export interface ChecklistGapInput {
  // `<documentType>.<item>`, from findMissingStandardClauses().
  gapId: string;
  topic: string;
  explanation: string;
  // Shown to the reader: false when the service dropped it as already covered by a model finding.
  served: boolean;
}

export interface ChecklistGapRow extends ChecklistGapInput {
  matches: { entryId: string; required: boolean; keywords: string[] }[];
  assignedTo: string | null;
  // Not confirmed by the key: anchored key entries whose description shares this gap's wording,
  // i.e. places the document may in fact address the topic. For a human to read, never scored.
  mayBeCoveredBy: { entryId: string; sharedWords: string[] }[];
}

export interface ChecklistMetrics {
  requiredMissing: string[];
  // Required missing-clause entries credited by the checklist's own output, before the dedup.
  credited: string[];
  // The subset credited by gaps the reader is actually shown.
  creditedServed: string[];
  gaps: ChecklistGapRow[];
  // Gaps no key entry confirms: each is either a gap the key lacks or a false absence claim.
  unconfirmed: number;
}

// Words that say nothing about a topic, so sharing them is no evidence the document covers it.
const GENERIC_WORDS = new Set([
  "that", "this", "with", "from", "does", "appear", "agreement", "document", "letter", "policy", "what", "when",
  "which", "will", "your", "their", "them", "they", "have", "been", "into", "only", "also", "such", "there",
  "these", "those", "would", "could", "should", "about", "other", "under", "clause", "party", "parties",
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word))
      .map((word) => word.replace(/s$/, "")),
  );
}

// A gap and a missing-clause key entry match on the entry's matchKeywords, over the gap's topic and
// explanation — the same rule the model's missing-clause findings are held to. One gap to one entry,
// required entries first.
export function measureChecklist(entries: readonly KeyEntry[], gaps: readonly ChecklistGapInput[]): ChecklistMetrics {
  const missing = entries.filter((entry) => entry.category === "missing_clause");
  const pairs: { gap: number; entry: number; required: boolean; keywords: string[] }[] = [];
  gaps.forEach((gap, g) => {
    missing.forEach((entry, e) => {
      const keywords = matchedPhrases(`${gap.topic}\n${gap.explanation}`, entry.matchKeywords ?? []);
      if (keywords.length > 0) pairs.push({ gap: g, entry: e, required: entry.required, keywords });
    });
  });
  pairs.sort((a, b) => Number(b.required) - Number(a.required) || a.gap - b.gap || a.entry - b.entry);
  const takenGaps = new Map<number, number>();
  const takenEntries = new Set<number>();
  for (const pair of pairs) {
    if (takenGaps.has(pair.gap) || takenEntries.has(pair.entry)) continue;
    takenGaps.set(pair.gap, pair.entry);
    takenEntries.add(pair.entry);
  }

  const anchored = entries.filter((entry) => entry.anchor !== null);
  const rows: ChecklistGapRow[] = gaps.map((gap, g) => {
    const assigned = takenGaps.get(g);
    const matches = pairs.filter((p) => p.gap === g).map((p) => ({ entryId: missing[p.entry].id, required: p.required, keywords: p.keywords }));
    const words = significantWords(`${gap.topic} ${gap.explanation}`);
    const mayBeCoveredBy =
      matches.length > 0
        ? []
        : anchored
            .map((entry) => ({ entryId: entry.id, sharedWords: [...significantWords(entry.description)].filter((w) => words.has(w)) }))
            .filter((hint) => hint.sharedWords.length >= 2)
            .sort((a, b) => b.sharedWords.length - a.sharedWords.length)
            .slice(0, 2);
    return { ...gap, matches, assignedTo: assigned === undefined ? null : missing[assigned].id, mayBeCoveredBy };
  });

  const requiredMissing = missing.filter((entry) => entry.required).map((entry) => entry.id);
  const credited = rows.flatMap((row) => (row.assignedTo !== null && requiredMissing.includes(row.assignedTo) ? [row.assignedTo] : []));
  const creditedServed = rows.flatMap((row) => (row.served && row.assignedTo !== null && requiredMissing.includes(row.assignedTo) ? [row.assignedTo] : []));
  return { requiredMissing, credited, creditedServed, gaps: rows, unconfirmed: rows.filter((row) => row.matches.length === 0).length };
}
