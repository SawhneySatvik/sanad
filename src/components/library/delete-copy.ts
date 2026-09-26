/**
 * ConfirmDeleteDialog's own `defaultDescription` doesn't match this screen's exact per-type grammar
 * (it prints a literal "(s)" and a single flattened sentence instead of one grammatically correct
 * line per non-zero impact field) — every call site here always passes an explicit `description`
 * built from these functions instead of relying on the shared dialog's default.
 */

import type { DeleteImpact } from "@/components/shell/confirm-delete-dialog";

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/** The document delete dialog's body: the fixed opener, one line per non-zero impact field, then the fixed local-thread addendum. */
export function documentDeleteDescription(title: string, impact: DeleteImpact | undefined): string {
  const lines = [`Delete '${title}'? This can't be undone.`];
  if (impact) {
    if (impact.comparisons > 0) {
      lines.push(`${impact.comparisons} ${plural(impact.comparisons, "comparison", "comparisons")} will also be deleted.`);
    }
    if (impact.draftsUngrounded > 0) {
      lines.push(
        impact.draftsUngrounded === 1
          ? "1 draft will lose its grounding document."
          : `${impact.draftsUngrounded} drafts will lose their grounding document.`,
      );
    }
    if (impact.threadsUnlinked > 0) {
      lines.push(
        impact.threadsUnlinked === 1
          ? "1 saved chat will lose this document as a source."
          : `${impact.threadsUnlinked} saved chats will lose this document as a source.`,
      );
    }
  }
  lines.push("Chats on this device that quote it will show it as unavailable.");
  return lines.join(" ");
}

export const COMPARISON_DELETE_DESCRIPTION = "Delete this comparison? Changes cascade. The two documents are untouched.";

export function draftDeleteDescription(revisionCount: number): string {
  return revisionCount === 1
    ? "Delete this draft? All 1 revision will be deleted."
    : `Delete this draft? All ${revisionCount} revisions will be deleted.`;
}

export const THREAD_DELETE_DESCRIPTION = "Delete this chat? This can't be undone.";

export function libraryDeleteDescription(
  itemType: "document" | "comparison" | "draft" | "thread",
  input: { title: string; impact?: DeleteImpact; revisionCount?: number },
): string {
  if (itemType === "document") return documentDeleteDescription(input.title, input.impact);
  if (itemType === "comparison") return COMPARISON_DELETE_DESCRIPTION;
  if (itemType === "draft") return draftDeleteDescription(input.revisionCount ?? 1);
  return THREAD_DELETE_DESCRIPTION;
}
