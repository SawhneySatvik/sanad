/**
 * ExportMenu's Copy action needs plain text a reader can paste into a chat message — deliberately
 * NOT prepare.markdown (which is escaped Markdown, meant for the Download action only). Never routes
 * through escapeMarkdown, and never renders a status word of its own ("Verified"/"Approximate"): a
 * citation contributes its plain quote text only, looked up from documentFindings the same way
 * FindingCitation does — never PrepareFindingRefOutput.verification directly (the badge-collision
 * ruling applies to plain-text export too, not just the on-screen badge).
 */

import { lensLabel } from "@/shared/lens-labels";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareCompleteOutput, PrepareFindingRefOutput } from "./types";
import { CHECKLIST_HEADING, QUESTIONS_HEADING, preparedForHeading } from "./copy";

// null for a missing_clause (nothing to quote), a stale/unmatched id, or a not_found claim — none of
// those have a spanText a reader could usefully paste.
function citationText(citation: PrepareFindingRefOutput, documentFindings: readonly FindingOutput[]): string | null {
  const finding = documentFindings.find((candidate) => candidate.id === citation.id);
  if (!finding || finding.verification === null || finding.verification.status === "not_found") return null;
  return finding.verification.spanText;
}

export function buildPrepareCopyText(prepare: PrepareCompleteOutput, documentFindings: readonly FindingOutput[]): string {
  const lines: string[] = [preparedForHeading(lensLabel(prepare.lens)), "", QUESTIONS_HEADING, ""];

  if (prepare.lawyerQuestions.length === 0) {
    lines.push("No questions were generated for this document.", "");
  } else {
    for (const question of prepare.lawyerQuestions) {
      lines.push(question.question, question.whyItMatters);
      for (const citation of question.findings) {
        const text = citationText(citation, documentFindings);
        if (text !== null) lines.push(`"${text}"`);
      }
      lines.push("");
    }
  }

  lines.push(CHECKLIST_HEADING, "");
  if (prepare.checklist.length === 0) {
    lines.push("No checklist items were generated for this document.");
  } else {
    for (const item of prepare.checklist) {
      lines.push(item.item);
      for (const citation of item.findings) {
        const text = citationText(citation, documentFindings);
        if (text !== null) lines.push(`"${text}"`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
