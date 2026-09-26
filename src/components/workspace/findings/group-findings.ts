/**
 * Grouping and sorting only — never a ranking. Categories render in DOCUMENT_CATEGORIES' own fixed
 * order (obligation, deadline, penalty, ambiguity, missing_clause); within a group,
 * findings run in document order (ascending verification.spanStart). A finding with no span
 * (not_found, or a checklist finding with no verification at all) sorts after every spanned finding
 * in its group, in the server's own array order — Array#sort is stable, so giving every unspanned
 * finding the same rank preserves that order for free.
 */

import { DOCUMENT_CATEGORIES } from "@/shared/contracts/vocabulary";
import type { FindingOutput } from "@/shared/contracts/documents";

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export interface FindingGroupData {
  category: DocumentCategory;
  findings: FindingOutput[];
}

function spanRank(finding: FindingOutput): number {
  const verification = finding.verification;
  if (verification && verification.status !== "not_found") return verification.spanStart;
  return Number.POSITIVE_INFINITY;
}

function byDocumentOrder(a: FindingOutput, b: FindingOutput): number {
  const rankA = spanRank(a);
  const rankB = spanRank(b);
  return rankA === rankB ? 0 : rankA - rankB;
}

/** Only categories with at least one finding produce a group — a category nothing was found for renders no heading at all. */
export function groupFindingsByCategory(findings: readonly FindingOutput[]): FindingGroupData[] {
  const groups: FindingGroupData[] = [];
  for (const category of DOCUMENT_CATEGORIES) {
    const inCategory = findings.filter((finding) => finding.category === category);
    if (inCategory.length === 0) continue;
    groups.push({ category, findings: inCategory.slice().sort(byDocumentOrder) });
  }
  return groups;
}

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  obligation: "Obligation",
  deadline: "Deadline",
  penalty: "Penalty",
  ambiguity: "Ambiguity",
  missing_clause: "Missing clause",
};
