/**
 * "Open in document" opens the newer version whenever there is one — added/changed open document
 * B, removed (present only in A) opens document A. One control per card, not one per side.
 */

import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import type { ComparisonChange } from "./change-card";

export function resolveOpenDocumentId(
  change: Pick<ComparisonChange, "changeType">,
  comparison: Pick<ComparisonWithChangesOutput, "documentAId" | "documentBId">,
): string {
  return change.changeType === "removed" ? comparison.documentAId : comparison.documentBId;
}
