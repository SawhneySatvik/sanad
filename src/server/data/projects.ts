/**
 * Projects repository. Every function authorizes through canAccess — a foreign, missing, or malformed
 * id is the same NOT_FOUND. `projects.owner_user_id` is NOT NULL: a guest-named project is NOT_FOUND
 * like another user's. Any standalone item can be saved into a project after the fact — saveToProject
 * sets project_id and clears expires_at in one statement, taking it out of the guest-TTL sweep's scope.
 */

import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { AppError } from "../core/errors";
import type { Principal } from "../core/types";
import { assertCanAccess, assertCanAccessAll, canAccess, type OwnedResource } from "./access";
import { isUuidShaped } from "./documents";

/** A persisted project row, as read from the database. */
export type Project = typeof schema.projects.$inferSelect;

/** Fields required to create a project. */
export interface CreateProjectInput {
  name: string;
  color?: string | null;
  icon?: string | null;
}

/** The kinds of item that can belong to a project. */
export type ProjectItemKind = "document" | "comparison" | "draft" | "thread";

/** One item to save into a project. */
export interface ProjectItem {
  kind: ProjectItemKind;
  id: string;
}

/** The result of saving an item into a project. */
export interface SavedToProject {
  projectId: string;
  kind: ProjectItemKind;
  // Every row the save moved: one id, or a draft's whole revision chain.
  itemIds: string[];
}

// No canonical_text (up to 500k chars) and no storage_ref: a project listing needs neither.
const documentSummaryColumns = {
  id: schema.documents.id,
  ownerUserId: schema.documents.ownerUserId,
  ownerGuestSessionId: schema.documents.ownerGuestSessionId,
  projectId: schema.documents.projectId,
  filename: schema.documents.filename,
  mimeType: schema.documents.mimeType,
  inputMode: schema.documents.inputMode,
  processingStatus: schema.documents.processingStatus,
  documentType: schema.documents.documentType,
  jurisdiction: schema.documents.jurisdiction,
  uploadedAt: schema.documents.uploadedAt,
  expiresAt: schema.documents.expiresAt,
};

const comparisonSummaryColumns = {
  id: schema.comparisons.id,
  ownerUserId: schema.comparisons.ownerUserId,
  ownerGuestSessionId: schema.comparisons.ownerGuestSessionId,
  projectId: schema.comparisons.projectId,
  documentAId: schema.comparisons.documentAId,
  documentBId: schema.comparisons.documentBId,
  modelUsed: schema.comparisons.modelUsed,
  createdAt: schema.comparisons.createdAt,
  expiresAt: schema.comparisons.expiresAt,
};

// No content: the draft text is read through the drafts repository.
const draftSummaryColumns = {
  id: schema.drafts.id,
  ownerUserId: schema.drafts.ownerUserId,
  ownerGuestSessionId: schema.drafts.ownerGuestSessionId,
  projectId: schema.drafts.projectId,
  documentType: schema.drafts.documentType,
  mode: schema.drafts.mode,
  groundingDocumentId: schema.drafts.groundingDocumentId,
  revisionNumber: schema.drafts.revisionNumber,
  parentDraftId: schema.drafts.parentDraftId,
  jurisdiction: schema.drafts.jurisdiction,
  modelUsed: schema.drafts.modelUsed,
  createdAt: schema.drafts.createdAt,
  expiresAt: schema.drafts.expiresAt,
};

const threadSummaryColumns = {
  id: schema.threads.id,
  ownerUserId: schema.threads.ownerUserId,
  projectId: schema.threads.projectId,
  title: schema.threads.title,
  createdAt: schema.threads.createdAt,
  updatedAt: schema.threads.updatedAt,
};

/** A project with every item that belongs to it, each already filtered to what `principal` can see. */
export interface ProjectDetail {
  project: Project;
  documents: Awaited<ReturnType<typeof selectDocuments>>;
  comparisons: Awaited<ReturnType<typeof selectComparisons>>;
  drafts: Awaited<ReturnType<typeof selectDrafts>>;
  threads: Awaited<ReturnType<typeof selectThreads>>;
}

// Threads and projects have no guest owner column.
function userOwned(row: { ownerUserId: string }): OwnedResource {
  return { ownerUserId: row.ownerUserId, ownerGuestSessionId: null };
}

/** Creates a project for a user principal; throws for a guest. */
export async function createProject(db: Db, principal: Principal, input: CreateProjectInput): Promise<Project> {
  if (principal.type !== "user") {
    throw new AppError("VALIDATION_FAILED", "Guest sessions cannot create a project — sign in first.");
  }
  if (input.name.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", "A project needs a name.");
  }
  const [row] = await db
    .insert(schema.projects)
    .values({ ownerUserId: principal.userId, name: input.name, color: input.color ?? null, icon: input.icon ?? null })
    .returning();
  return row;
}

/** Every project `principal` owns, most recently opened first (opened_at is the sidebar's bucketing key). */
export async function listProjects(db: Db, principal: Principal): Promise<Project[]> {
  if (principal.type !== "user") return [];
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.ownerUserId, principal.userId))
    .orderBy(desc(schema.projects.openedAt), desc(schema.projects.id));
  // The WHERE clause narrows the scan; canAccess stays the authority on what is returned.
  return rows.filter((row) => canAccess(principal, userOwned(row)));
}

function selectDocuments(db: Db, projectId: string) {
  return db
    .select(documentSummaryColumns)
    .from(schema.documents)
    .where(eq(schema.documents.projectId, projectId))
    .orderBy(desc(schema.documents.uploadedAt), desc(schema.documents.id));
}

function selectComparisons(db: Db, projectId: string) {
  return db
    .select(comparisonSummaryColumns)
    .from(schema.comparisons)
    .where(eq(schema.comparisons.projectId, projectId))
    .orderBy(desc(schema.comparisons.createdAt), desc(schema.comparisons.id));
}

function selectDrafts(db: Db, projectId: string) {
  return db
    .select(draftSummaryColumns)
    .from(schema.drafts)
    .where(eq(schema.drafts.projectId, projectId))
    .orderBy(desc(schema.drafts.createdAt), desc(schema.drafts.id));
}

function selectThreads(db: Db, projectId: string) {
  return db
    .select(threadSummaryColumns)
    .from(schema.threads)
    .where(eq(schema.threads.projectId, projectId))
    .orderBy(desc(schema.threads.updatedAt), desc(schema.threads.id));
}

/** Does not touch opened_at: a read stays a read. Every item row is filtered through canAccess too, so a foreign row is never listed. */
export async function getProject(db: Db, principal: Principal, projectId: string): Promise<ProjectDetail> {
  const [project] = isUuidShaped(projectId)
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    : [];
  assertCanAccess(principal, project && userOwned(project));

  const documents = await selectDocuments(db, project.id);
  const comparisons = await selectComparisons(db, project.id);
  const drafts = await selectDrafts(db, project.id);
  const threads = await selectThreads(db, project.id);

  return {
    project,
    documents: documents.filter((row) => canAccess(principal, row)),
    comparisons: comparisons.filter((row) => canAccess(principal, row)),
    drafts: drafts.filter((row) => canAccess(principal, row)),
    threads: threads.filter((row) => canAccess(principal, userOwned(row))),
  };
}

// Every revision connected to `draftId` through parent_draft_id: its ancestors up to the root, and
// everything descending from any of them. UNION (not UNION ALL) so a malformed cyclic chain still
// terminates.
function draftChainIds(draftId: string) {
  return sql`(
    WITH RECURSIVE ancestors (id, parent_draft_id) AS (
      SELECT id, parent_draft_id FROM drafts WHERE id = ${draftId}
      UNION
      SELECT d.id, d.parent_draft_id FROM drafts d JOIN ancestors a ON d.id = a.parent_draft_id
    ), chain (id) AS (
      SELECT id FROM ancestors
      UNION
      SELECT d.id FROM drafts d JOIN chain c ON d.parent_draft_id = c.id
    )
    SELECT id FROM chain
  )`;
}

// The rows a save would move, locked until the transaction ends.
async function lockItemRows(tx: Db, item: ProjectItem): Promise<(OwnedResource & { id: string })[]> {
  switch (item.kind) {
    case "document":
      return tx
        .select({ id: schema.documents.id, ownerUserId: schema.documents.ownerUserId, ownerGuestSessionId: schema.documents.ownerGuestSessionId })
        .from(schema.documents)
        .where(eq(schema.documents.id, item.id))
        .for("update");
    case "comparison":
      return tx
        .select({ id: schema.comparisons.id, ownerUserId: schema.comparisons.ownerUserId, ownerGuestSessionId: schema.comparisons.ownerGuestSessionId })
        .from(schema.comparisons)
        .where(eq(schema.comparisons.id, item.id))
        .for("update");
    case "draft":
      return tx
        .select({ id: schema.drafts.id, ownerUserId: schema.drafts.ownerUserId, ownerGuestSessionId: schema.drafts.ownerGuestSessionId })
        .from(schema.drafts)
        .where(sql`${schema.drafts.id} IN ${draftChainIds(item.id)}`)
        .orderBy(asc(schema.drafts.revisionNumber), asc(schema.drafts.id))
        .for("update");
    case "thread": {
      const rows = await tx
        .select({ id: schema.threads.id, ownerUserId: schema.threads.ownerUserId })
        .from(schema.threads)
        .where(eq(schema.threads.id, item.id))
        .for("update");
      return rows.map((row) => ({ id: row.id, ownerUserId: row.ownerUserId, ownerGuestSessionId: null }));
    }
  }
}

// One statement per save: project_id and expires_at change together, so no instant exists where a
// saved item is still in the sweep's scope. Threads have no expires_at (never guest-owned).
async function moveItemRows(tx: Db, kind: ProjectItemKind, ids: string[], projectId: string): Promise<void> {
  switch (kind) {
    case "document":
      await tx.update(schema.documents).set({ projectId, expiresAt: null }).where(inArray(schema.documents.id, ids));
      return;
    case "comparison":
      await tx.update(schema.comparisons).set({ projectId, expiresAt: null }).where(inArray(schema.comparisons.id, ids));
      return;
    case "draft":
      await tx.update(schema.drafts).set({ projectId, expiresAt: null }).where(inArray(schema.drafts.id, ids));
      return;
    case "thread":
      await tx.update(schema.threads).set({ projectId }).where(inArray(schema.threads.id, ids));
      return;
  }
}

/**
 * Saves (or moves — an item already in another of the caller's projects is re-pointed) an item into
 * a project. Multi-entity rule: the caller must own the project and every row the save moves.
 * A draft is saved as its whole revision chain, ancestors included. The sweep deletes a chain newest
 * revision first and parent_draft_id is RESTRICT, so a saved revision whose ancestor still expires
 * would pin that ancestor forever, and a chain split across projects would split one draft's history.
 */
export async function saveToProject(
  db: Db,
  principal: Principal,
  item: ProjectItem,
  projectId: string,
): Promise<SavedToProject> {
  return db.transaction(async (tx) => {
    // Every query uses tx: PGlite has one connection, and a query on db here would wait forever.
    const [project] = isUuidShaped(projectId)
      ? await tx
          .select({ ownerUserId: schema.projects.ownerUserId })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .for("share")
      : [];
    const rows = isUuidShaped(item.id) ? await lockItemRows(tx, item) : [];
    // An empty item lookup is passed as `undefined`, so it denies like a foreign item.
    assertCanAccessAll(principal, [project && userOwned(project), ...(rows.length > 0 ? rows : [undefined])]);

    const itemIds = rows.map((row) => row.id);
    await moveItemRows(tx, item.kind, itemIds, projectId);
    return { projectId, kind: item.kind, itemIds };
  });
}
