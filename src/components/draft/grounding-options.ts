import type { DocumentWithFindingsOutput } from "@/shared/contracts/documents";
import type { DocumentListRow } from "./types";
import type { GroundingOption } from "./grounding-document-picker";

export function optionFromListRow(row: DocumentListRow): GroundingOption {
  return { id: row.id, title: row.title, processingStatus: row.processingStatus };
}

export function optionFromDocumentDetail(detail: DocumentWithFindingsOutput): GroundingOption {
  return { id: detail.document.id, title: detail.document.title, processingStatus: detail.document.processingStatus };
}

/** Merges the deep-linked/preselected document into the fetched list, never duplicating its id. */
export function mergeGroundingOptions(list: GroundingOption[], preselected: GroundingOption | null | undefined): GroundingOption[] {
  if (!preselected) return list;
  if (list.some((option) => option.id === preselected.id)) return list;
  return [preselected, ...list];
}
