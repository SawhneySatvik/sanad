/**
 * Projects repository. Every function authorizes through canAccess — a foreign, missing, or malformed
 * id is the same NOT_FOUND. `projects.owner_user_id` is NOT NULL: a guest-named project is NOT_FOUND
 * like another user's. Any standalone item can be saved into a project after the fact — saveToProject
 * sets project_id and clears expires_at in one statement, taking it out of the guest-TTL sweep's scope.
 */

import { desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { DOCUMENT_TYPE_REGISTRY } from "../deterministic/document-type-registry";
import { assertCanAccess, assertCanAccessAll, canAccess, type OwnedResource } from "./access";
import { isUuidShaped } from "./documents";
import { draftChain, getLibraryRow, lockDraftChain } from "./library";

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
  title: schema.documents.title,
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
  title: schema.comparisons.title,
  titleA: sql<string>`(select coalesce(d.title, d.filename) from documents d where d.id = ${schema.comparisons.documentAId} and d.owner_user_id is not distinct from ${schema.comparisons.ownerUserId} and d.owner_guest_session_id is not distinct from ${schema.comparisons.ownerGuestSessionId} and (d.expires_at is null or d.expires_at > now()))`,
  titleB: sql<string>`(select coalesce(d.title, d.filename) from documents d where d.id = ${schema.comparisons.documentBId} and d.owner_user_id is not distinct from ${schema.comparisons.ownerUserId} and d.owner_guest_session_id is not distinct from ${schema.comparisons.ownerGuestSessionId} and (d.expires_at is null or d.expires_at > now()))`,
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
  title: schema.drafts.title,
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

async function selectDrafts(db: Db, projectId: string) {
  const rows = await db
    .select(draftSummaryColumns)
    .from(schema.drafts)
    .where(eq(schema.drafts.projectId, projectId))
    .orderBy(desc(schema.drafts.createdAt), desc(schema.drafts.id));
  return rows.map((row) => ({ ...row, title: row.title ?? `${DOCUMENT_TYPE_REGISTRY.find((entry) => entry.id === row.documentType)?.label ?? row.documentType} draft` }));
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

  // Four independent reads, all keyed only on project.id — no data dependency between them.
  const [documents, comparisons, drafts, threads] = await Promise.all([
    selectDocuments(db, project.id),
    selectComparisons(db, project.id),
    selectDrafts(db, project.id),
    selectThreads(db, project.id),
  ]);

  for (const row of documents) assertCanAccess(principal, row);
  for (const row of comparisons) {
    assertCanAccess(principal, row);
    if (row.titleA === null || row.titleB === null) throw notFound();
    await getLibraryRow(db, principal, "comparison", row.id);
  }
  for (const row of drafts) {
    assertCanAccess(principal, row);
    await draftChain(db, principal, row.id);
  }
  for (const row of threads) assertCanAccess(principal, userOwned(row));

  return {
    project,
    documents,
    comparisons,
    drafts,
    threads,
  };
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
      throw new Error("Draft chain locks require the principal.");
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
      await tx.update(schema.documents).set({ projectId, expiresAt: null, updatedAt: sql`now()` }).where(inArray(schema.documents.id, ids));
      return;
    case "comparison":
      await tx.update(schema.comparisons).set({ projectId, expiresAt: null, updatedAt: sql`now()` }).where(inArray(schema.comparisons.id, ids));
      return;
    case "draft":
      await tx.update(schema.drafts).set({ projectId, expiresAt: null, updatedAt: sql`now()` }).where(inArray(schema.drafts.id, ids));
      return;
    case "thread":
      await tx.update(schema.threads).set({ projectId, updatedAt: sql`now()` }).where(inArray(schema.threads.id, ids));
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
    const rows = isUuidShaped(item.id)
      ? item.kind === "draft" ? await lockDraftChain(tx, principal, item.id) : await lockItemRows(tx, item)
      : [];
    // An empty item lookup is passed as `undefined`, so it denies like a foreign item.
    assertCanAccessAll(principal, [project && userOwned(project), ...(rows.length > 0 ? rows : [undefined])]);
    await getLibraryRow(tx, principal, item.kind, item.id);

    const itemIds = rows.map((row) => row.id);
    await moveItemRows(tx, item.kind, itemIds, projectId);
    return { projectId, kind: item.kind, itemIds };
  });
}
