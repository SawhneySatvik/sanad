/**
 * The one place this page turns its own findings into segmentDocumentText()'s BoundEntry list — every
 * range in it already came from bindSpan(), never a raw slice. A checklist finding (verification ===
 * null) contributes nothing; a not_found finding's bindSpan() call already returns null and is
 * naturally dropped the same way a stale/mismatched one would be.
 */

import { bindSpan, type BindSpanTarget } from "@/lib/verification/bindSpan";
import type { BoundEntry } from "@/lib/verification/segmentDocumentText";
import type { FindingOutput } from "@/shared/contracts/documents";

export const VERIFIER_DEMO_FINDING_ID = "__verifier_demo__";
/** A CitationChip has no finding id of its own — this is the one synthetic slot its bound jump/highlight uses, replaced (never accumulated) on each new click. */
export const CITATION_HIGHLIGHT_FINDING_ID = "__citation_highlight__";

export interface ExtraBoundEntry {
  findingId: string;
  range: { spanStart: number; spanEnd: number; spanText: string };
  tone: "default" | "approximate";
}

export function buildBoundEntries(documentId: string, findings: readonly FindingOutput[], target: BindSpanTarget, extra: ExtraBoundEntry[] = []): BoundEntry[] {
  const entries: BoundEntry[] = [];
  for (const finding of findings) {
    if (!finding.verification) continue;
    const bound = bindSpan(finding.verification, target, { documentId });
    if (!bound) continue;
    entries.push({ findingId: finding.id, range: bound, tone: finding.verification.status === "approximate" ? "approximate" : "default" });
  }
  entries.push(...extra);
  return entries;
}
