/**
 * The projects repository's rows -> the wire shape. Explicit field mapping, not a spread, so the
 * stripping doesn't rely on the response contract alone. Never carries owner columns,
 * canonical_text, storage_ref, draft content or a processing/verification status.
 */

import type { Project, ProjectDetail } from "@/server/data/projects";

/** Maps one project row to the wire shape. */
export function projectView(project: Project) {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    icon: project.icon,
    openedAt: project.openedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/** Maps a project list to the wire shape. */
export function projectsListView(projects: readonly Project[]) {
  return { projects: projects.map(projectView) };
}

function documentSummaryView(row: ProjectDetail["documents"][number]) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    inputMode: row.inputMode,
    documentType: row.documentType,
    jurisdiction: row.jurisdiction,
    uploadedAt: row.uploadedAt,
    expiresAt: row.expiresAt,
  };
}

function comparisonSummaryView(row: ProjectDetail["comparisons"][number]) {
  return {
    id: row.id,
    documentAId: row.documentAId,
    documentBId: row.documentBId,
    modelUsed: row.modelUsed,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function draftSummaryView(row: ProjectDetail["drafts"][number]) {
  return {
    id: row.id,
    documentType: row.documentType,
    mode: row.mode,
    groundingDocumentId: row.groundingDocumentId,
    revisionNumber: row.revisionNumber,
    parentDraftId: row.parentDraftId,
    jurisdiction: row.jurisdiction,
    modelUsed: row.modelUsed,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function threadSummaryView(row: ProjectDetail["threads"][number]) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maps a project's full detail (documents/comparisons/drafts/threads summaries) to the wire shape. */
export function projectDetailView(detail: ProjectDetail) {
  return {
    project: projectView(detail.project),
    documents: detail.documents.map(documentSummaryView),
    comparisons: detail.comparisons.map(comparisonSummaryView),
    drafts: detail.drafts.map(draftSummaryView),
    threads: detail.threads.map(threadSummaryView),
  };
}
