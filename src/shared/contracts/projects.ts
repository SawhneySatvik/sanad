/**
 * POST /api/projects, GET /api/projects, GET /api/projects/:id, and
 * POST /api/{documents,comparisons,drafts,threads}/:id/save-to-project. A project payload is a
 * handle list for the sidebar, never the item itself: no owner columns, no canonical_text, no
 * storage_ref, no draft content, and no processing/verification status of any kind — a client that
 * wants an item's own detail calls its own GET route, which re-verifies fresh. CreateProjectInput
 * is strict: a client can never submit ownerUserId or any other server-owned field.
 */

import { z } from "zod";
import { INPUT_MODES } from "./vocabulary";
import { IsoDateTime } from "./common";

/** POST /api/projects' request body. */
export const CreateProjectInput = z.strictObject({
  name: z.string().min(1).max(255),
  color: z.string().max(64).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

// Owner columns deliberately absent (never on the wire).
/** A project's wire shape. */
export const ProjectOutput = z.object({
  id: z.guid(),
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  openedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectOutput = z.infer<typeof ProjectOutput>;

/** GET /api/projects' response. */
export const ProjectsListOutput = z.object({ projects: z.array(ProjectOutput) });
export type ProjectsListOutput = z.infer<typeof ProjectsListOutput>;

/**
 * A document handle for a project's sidebar; no canonical_text, storage_ref or processing
 * status — GET /api/documents/:id re-verifies fresh.
 */
export const ProjectDocumentSummaryOutput = z.object({
  id: z.guid(),
  title: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  inputMode: z.enum(INPUT_MODES).nullable(),
  documentType: z.string().nullable(),
  jurisdiction: z.string(),
  uploadedAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
});
export type ProjectDocumentSummaryOutput = z.infer<typeof ProjectDocumentSummaryOutput>;

/** A comparison handle for a project's sidebar. */
export const ProjectComparisonSummaryOutput = z.object({
  id: z.guid(),
  title: z.string(),
  documentAId: z.guid(),
  documentBId: z.guid(),
  modelUsed: z.string(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
});
export type ProjectComparisonSummaryOutput = z.infer<typeof ProjectComparisonSummaryOutput>;

/** A draft handle for a project's sidebar; no `content` — read through GET /api/drafts/:id. */
export const ProjectDraftSummaryOutput = z.object({
  id: z.guid(),
  title: z.string(),
  documentType: z.string(),
  mode: z.enum(["from_scratch", "document_grounded"]),
  groundingDocumentId: z.guid().nullable(),
  revisionNumber: z.number().int(),
  parentDraftId: z.guid().nullable(),
  jurisdiction: z.string(),
  modelUsed: z.string(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
});
export type ProjectDraftSummaryOutput = z.infer<typeof ProjectDraftSummaryOutput>;

/** A thread handle for a project's sidebar. */
export const ProjectThreadSummaryOutput = z.object({
  id: z.guid(),
  title: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectThreadSummaryOutput = z.infer<typeof ProjectThreadSummaryOutput>;

/** GET /api/projects/:id's response: the project plus its documents/comparisons/drafts/threads handle lists. */
export const ProjectDetailOutput = z.object({
  project: ProjectOutput,
  documents: z.array(ProjectDocumentSummaryOutput),
  comparisons: z.array(ProjectComparisonSummaryOutput),
  drafts: z.array(ProjectDraftSummaryOutput),
  threads: z.array(ProjectThreadSummaryOutput),
});
export type ProjectDetailOutput = z.infer<typeof ProjectDetailOutput>;

// ---- save-to-project: shared shape across documents/comparisons/drafts/threads ----

// A body field, so a strict z.guid() would make a malformed id 400 while a foreign/missing project
// is 404 — a bounded z.string() lets the repository answer uniformly instead.
/** POST /api/{documents,comparisons,drafts,threads}/:id/save-to-project's request body. */
export const SaveToProjectInput = z.strictObject({
  projectId: z.string().min(1).max(64),
});
export type SaveToProjectInput = z.infer<typeof SaveToProjectInput>;

/** The save-to-project response: the project and the ids actually saved into it. */
export const SaveToProjectOutput = z.object({
  projectId: z.guid(),
  itemIds: z.array(z.guid()),
});
export type SaveToProjectOutput = z.infer<typeof SaveToProjectOutput>;
