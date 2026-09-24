import { z } from "zod";
import { IsoDateTime } from "./common";

export const ListQuery = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

export const RenameInput = z.strictObject({ title: z.string().min(1).max(1000) });
export const RenameProjectInput = z.strictObject({ name: z.string().min(1).max(1000) });

export const DocumentListRowOutput = z.object({
  id: z.guid(), title: z.string(), filename: z.string(), documentType: z.string().nullable(),
  processingStatus: z.enum(["pending", "ready", "extraction_failed"]),
  analysisState: z.enum(["complete", "not_analyzed"]),
  inputMode: z.enum(["text", "native_document"]).nullable(),
  sampleId: z.string().nullable(), projectId: z.guid().nullable(),
  uploadedAt: IsoDateTime, updatedAt: IsoDateTime, expiresAt: IsoDateTime.nullable(),
});
export const ComparisonListRowOutput = z.object({
  id: z.guid(), title: z.string(), titleA: z.string(), titleB: z.string(),
  documentAId: z.guid(), documentBId: z.guid(), modelUsed: z.string(), projectId: z.guid().nullable(),
  createdAt: IsoDateTime, updatedAt: IsoDateTime, expiresAt: IsoDateTime.nullable(),
});
export const DraftListRowOutput = z.object({
  id: z.guid(), title: z.string(), documentType: z.string(), mode: z.enum(["from_scratch", "document_grounded"]),
  revisionCount: z.number().int().positive(), projectId: z.guid().nullable(),
  createdAt: IsoDateTime, updatedAt: IsoDateTime, expiresAt: IsoDateTime.nullable(),
});
export const ThreadListRowOutput = z.object({
  id: z.guid(), title: z.string().nullable(), projectId: z.guid().nullable(),
  createdAt: IsoDateTime, updatedAt: IsoDateTime,
});

export const DocumentListOutput = z.object({ items: z.array(DocumentListRowOutput), nextCursor: z.string().nullable() });
export const ComparisonListOutput = z.object({ items: z.array(ComparisonListRowOutput), nextCursor: z.string().nullable() });
export const DraftListOutput = z.object({ items: z.array(DraftListRowOutput), nextCursor: z.string().nullable() });
export const ThreadListOutput = z.object({ items: z.array(ThreadListRowOutput), nextCursor: z.string().nullable() });

export const DraftRevisionOutput = z.object({
  id: z.guid(), parentDraftId: z.guid().nullable(), revisionNumber: z.number().int().positive(),
  createdAt: IsoDateTime, modelUsed: z.string(), userInstructions: z.string().nullable(),
  isCurrent: z.boolean(), isLatest: z.boolean(),
});
export const DraftRevisionsOutput = z.object({ items: z.array(DraftRevisionOutput) });
export const DeleteImpactOutput = z.object({ comparisons: z.number().int().nonnegative(), draftsUngrounded: z.number().int().nonnegative(), threadsUnlinked: z.number().int().nonnegative() });
export const DeleteAllOutput = z.object({ deleted: z.object({
  documents: z.number().int().nonnegative(), comparisons: z.number().int().nonnegative(),
  drafts: z.number().int().nonnegative(), threads: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
}) });
