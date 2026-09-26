/**
 * The one place a comparison's changes become one side's segmentDocumentText() BoundEntry list.
 * `side` picks verificationA/documentAId (or B) INTERNALLY — a caller can never pass a verification
 * and a document id as two separate arguments, which is exactly the mix-up shape a side swap would
 * take. A change with no verification on this side (added/removed's absent side, or a fresh re-verify
 * that couldn't rebind it) contributes nothing; bindSpan()'s own stale-hash/mismatched-slice/wrong-
 * document checks drop the rest the same way build-bound-entries.ts already does for findings.
 */

import { bindSpan, type BindSpanTarget } from "@/lib/verification/bindSpan";
import type { BoundEntry } from "@/lib/verification/segmentDocumentText";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";

export type CompareSide = "A" | "B";

export function buildSideEntries(
  side: CompareSide,
  comparison: Pick<ComparisonWithChangesOutput, "documentAId" | "documentBId" | "changes">,
  target: BindSpanTarget,
): BoundEntry[] {
  const documentId = side === "A" ? comparison.documentAId : comparison.documentBId;
  const entries: BoundEntry[] = [];
  for (const change of comparison.changes) {
    const verification = side === "A" ? change.verificationA : change.verificationB;
    if (!verification) continue;
    const bound = bindSpan(verification, target, { documentId });
    if (!bound) continue;
    entries.push({ findingId: change.id, range: bound, tone: verification.status === "approximate" ? "approximate" : "default" });
  }
  return entries;
}
