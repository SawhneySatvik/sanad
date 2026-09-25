/**
 * prepareService's PrepareResult -> the prepare contract's wire shape. A pure mapper: the import of
 * the service's own shapes is `import type`, never a runtime dependency. Every finding reference's
 * `verification` is prepareService's own already-verified, already-sliced shape, passed through by
 * reference — this file never builds a spanText of its own. The three typed states (complete /
 * not_analyzed / no_grounded_findings) stay distinguishable because only `complete` carries
 * lawyerQuestions/checklist/markdown at all.
 */

import type {
  PrepareChecklistItem,
  PrepareFindingRef,
  PrepareQuestion,
  PrepareResult,
} from "@/server/services/prepare";
import { sanitizeModelText } from "@/server/deterministic/sanitize/model-text";

/** Maps a PrepareResult to the wire shape. */
export function prepareView(result: PrepareResult) {
  if (result.state !== "complete") {
    return { state: result.state, documentId: result.document.id };
  }
  return {
    state: "complete" as const,
    documentId: result.document.id,
    lens: result.lens,
    lawyerQuestions: result.lawyerQuestions.map(questionView),
    checklist: result.checklist.map(checklistItemView),
    modelUsed: result.modelUsed,
    promptVersion: result.promptVersion,
    markdown: result.markdown,
  };
}

// provenance is a real constant, not an approximation: a `complete` result only exists after a
// successful model call (no_grounded_findings is chosen instead whenever there's nothing to offer
// the model), so every question/item here is model text, unlike Compare's per-change explanation.
function questionView(question: PrepareQuestion) {
  return {
    question: sanitizeModelText(question.question),
    whyItMatters: sanitizeModelText(question.whyItMatters),
    provenance: "ai_generated" as const,
    findingIds: question.findingIds,
    findings: question.findings.map(findingRefView),
  };
}

function checklistItemView(item: PrepareChecklistItem) {
  return { item: sanitizeModelText(item.item), provenance: "ai_generated" as const, findingIds: item.findingIds, findings: item.findings.map(findingRefView) };
}

function findingRefView(ref: PrepareFindingRef) {
  return { id: ref.id, category: ref.category, verification: ref.verification };
}
