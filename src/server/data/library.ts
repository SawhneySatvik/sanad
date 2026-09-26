import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { assertCanAccess, canAccess } from "./access";
import { getDocumentSummary, isUuidShaped } from "./documents";
import { getThread } from "./threads";
import { sweepOrderOfDrafts } from "../auth/claim";
import { executeRows } from "./execute-rows";


export type LibraryKind = "document" | "comparison" | "draft" | "thread" | "project";

const documentListColumns = {
  id: schema.documents.id, ownerUserId: schema.documents.ownerUserId,
  ownerGuestSessionId: schema.documents.ownerGuestSessionId, projectId: schema.documents.projectId,
  storageRef: schema.documents.storageRef, filename: schema.documents.filename,
  mimeType: schema.documents.mimeType, inputMode: schema.documents.inputMode,
  processingStatus: schema.documents.processingStatus, canonicalTextHash: schema.documents.canonicalTextHash,
  extractorVersion: schema.documents.extractorVersion, documentType: schema.documents.documentType,
  jurisdiction: schema.documents.jurisdiction, detectionConfidence: schema.documents.detectionConfidence,
  uploadedAt: schema.documents.uploadedAt, expiresAt: schema.documents.expiresAt,
  title: schema.documents.title, sampleId: schema.documents.sampleId, updatedAt: schema.documents.updatedAt,
  cursorUpdatedAt: sql<string>`${schema.documents.updatedAt}::text`,
};

function active<T extends { expiresAt: Date | null }>(row: T): boolean {
  return row.expiresAt === null || row.expiresAt.getTime() > Date.now();
}

function owned<T extends { ownerUserId: string | null; ownerGuestSessionId: string | null }>(rows: T[], principal: Principal): T[] {
  return rows.filter((row) => canAccess(principal, row));
}

function userOwned<T extends { ownerUserId: string }>(rows: T[], principal: Principal): T[] {
  return rows.filter((row) => canAccess(principal, { ownerUserId: row.ownerUserId, ownerGuestSessionId: null }));
}

async function assertProjectReference(db: Db, principal: Principal, projectId: string | null) {
  if (!projectId) return;
  const [project] = await db.select({ ownerUserId: schema.projects.ownerUserId })
    .from(schema.projects).where(eq(schema.projects.id, projectId));
  assertCanAccess(principal, project && { ownerUserId: project.ownerUserId, ownerGuestSessionId: null });
}

async function assertComparisonReferences(db: Db, principal: Principal, row: typeof schema.comparisons.$inferSelect) {
  const documents = await db.select({ id: schema.documents.id, ownerUserId: schema.documents.ownerUserId,
    ownerGuestSessionId: schema.documents.ownerGuestSessionId, expiresAt: schema.documents.expiresAt,
    projectId: schema.documents.projectId }).from(schema.documents)
    .where(inArray(schema.documents.id, [row.documentAId, row.documentBId]));
  for (const id of [row.documentAId, row.documentBId]) {
    const document = documents.find((entry) => entry.id === id);
    assertCanAccess(principal, document);
    if (!active(document!)) throw notFound();
    await assertProjectReference(db, principal, document!.projectId);
  }
  await assertProjectReference(db, principal, row.projectId);
}

function validProject(projectId: AnyColumn | SQL, ownerUserId: AnyColumn | SQL) {
  return sql`(${projectId} IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = ${projectId} AND p.owner_user_id = ${ownerUserId}))`;
}

function validComparisonDocuments() {
  return sql`EXISTS (SELECT 1 FROM documents a WHERE a.id = ${schema.comparisons.documentAId}
    AND a.owner_user_id IS NOT DISTINCT FROM ${schema.comparisons.ownerUserId}
    AND a.owner_guest_session_id IS NOT DISTINCT FROM ${schema.comparisons.ownerGuestSessionId}
    AND (a.expires_at IS NULL OR a.expires_at > now())
    AND ${validProject(sql`a.project_id`, sql`a.owner_user_id`)})
    AND EXISTS (SELECT 1 FROM documents b WHERE b.id = ${schema.comparisons.documentBId}
    AND b.owner_user_id IS NOT DISTINCT FROM ${schema.comparisons.ownerUserId}
    AND b.owner_guest_session_id IS NOT DISTINCT FROM ${schema.comparisons.ownerGuestSessionId}
    AND (b.expires_at IS NULL OR b.expires_at > now())
    AND ${validProject(sql`b.project_id`, sql`b.owner_user_id`)})`;
}

export interface LibraryCursor { updatedAt: string; id: string }

// The three storage-ref functions below take no principal on purpose. Outbox rows are system-owned
// storage references with no owning row, and the live-reference check must span every principal: scoped
// to one, a purge could delete an object another owner's live document still points to. Only the cleanup
// worker and the post-commit delete acknowledgement call them; a route must never reach them.
export async function hasLiveStorageRef(db: Db, ref: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.documents.id }).from(schema.documents)
    .where(sql`lower(${schema.documents.storageRef}) = lower(${ref})`).limit(1);
  return !!row;
}

export async function pendingStorageCleanup(db: Db, limit: number) {
  return db.select().from(schema.storageCleanupOutbox)
    .where(and(isNull(schema.storageCleanupOutbox.purgedAt), sql`${schema.storageCleanupOutbox.nextAttemptAt} <= now()`,
      sql`NOT EXISTS (SELECT 1 FROM documents d WHERE lower(d.storage_ref) = lower(${schema.storageCleanupOutbox.storageRef}))`))
    .orderBy(asc(schema.storageCleanupOutbox.nextAttemptAt), asc(schema.storageCleanupOutbox.createdAt), asc(schema.storageCleanupOutbox.storageRef)).limit(limit);
}

export async function processQueuedStorageRef(db: Db, ref: string, purge: (tx: Db) => Promise<void>) {
  return db.transaction(async (tx) => {
    const [queued] = await tx.select().from(schema.storageCleanupOutbox)
      .where(eq(schema.storageCleanupOutbox.storageRef, ref)).for("update");
    if (!queued || queued.purgedAt !== null) return "missing" as const;
    if (await hasLiveStorageRef(tx, ref)) return "live" as const;
    try {
      await purge(tx);
    } catch {
      const attemptCount = queued.attemptCount + 1;
      const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(attemptCount - 1, 7));
      await tx.update(schema.storageCleanupOutbox).set({ attemptCount,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000) })
        .where(eq(schema.storageCleanupOutbox.storageRef, ref));
      return "failed" as const;
    }
    await tx.update(schema.storageCleanupOutbox).set({ purgedAt: sql`now()` })
      .where(eq(schema.storageCleanupOutbox.storageRef, ref));
    return "purged" as const;
  });
}

/** Display titles of the caller's documents among `ids`; a foreign id is silently absent. */
export async function documentTitles(db: Db, principal: Principal, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: schema.documents.id, title: schema.documents.title, filename: schema.documents.filename,
    ownerUserId: schema.documents.ownerUserId, ownerGuestSessionId: schema.documents.ownerGuestSessionId })
    .from(schema.documents).where(inArray(schema.documents.id, ids));
  return new Map(owned(rows, principal).map((row) => [row.id, row.title ?? row.filename]));
}

/** Which of the caller's documents among `ids` have at least one analysis run. */
export async function analyzedDocumentIds(db: Db, principal: Principal, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.selectDistinct({ id: schema.documents.id, ownerUserId: schema.documents.ownerUserId,
    ownerGuestSessionId: schema.documents.ownerGuestSessionId })
    .from(schema.analyses).innerJoin(schema.documents, eq(schema.documents.id, schema.analyses.documentId))
    .where(inArray(schema.analyses.documentId, ids));
  return new Set(owned(rows, principal).map((row) => row.id));
}

async function rowFor(db: Db, principal: Principal, kind: LibraryKind, id: string) {
  if (!isUuidShaped(id)) throw notFound();
  switch (kind) {
    case "document": {
      const row = await getDocumentSummary(db, principal, id);
      if (!active(row)) throw notFound();
      await assertProjectReference(db, principal, row.projectId);
      return row;
    }
    case "comparison": {
      const [row] = await db.select().from(schema.comparisons).where(eq(schema.comparisons.id, id));
      assertCanAccess(principal, row);
      if (!active(row)) throw notFound();
      await assertComparisonReferences(db, principal, row);
      return row;
    }
    case "draft": {
      const [row] = await db.select().from(schema.drafts).where(eq(schema.drafts.id, id));
      assertCanAccess(principal, row);
      if (!active(row)) throw notFound();
      await assertProjectReference(db, principal, row.projectId);
      return row;
    }
    case "thread": {
      const row = await getThread(db, principal, id);
      await assertProjectReference(db, principal, row.projectId);
      return row;
    }
    case "project": {
      const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
      assertCanAccess(principal, row && { ownerUserId: row.ownerUserId, ownerGuestSessionId: null });
      return row;
    }
  }
}

async function lockCurrentRow(tx: Db, principal: Principal, kind: LibraryKind, id: string) {
  if (!isUuidShaped(id)) throw notFound();
  const locked = kind === "document" ? (await tx.select(documentListColumns).from(schema.documents).where(eq(schema.documents.id, id)).for("update"))[0]
    : kind === "comparison" ? (await tx.select().from(schema.comparisons).where(eq(schema.comparisons.id, id)).for("update"))[0]
    : kind === "draft" ? (await tx.select().from(schema.drafts).where(eq(schema.drafts.id, id)).for("update"))[0]
    : kind === "thread" ? (await tx.select().from(schema.threads).where(eq(schema.threads.id, id)).for("update"))[0]
    : (await tx.select().from(schema.projects).where(eq(schema.projects.id, id)).for("update"))[0];
  assertCanAccess(principal, !locked ? undefined : (kind === "thread" || kind === "project")
    ? { ownerUserId: locked.ownerUserId, ownerGuestSessionId: null } : locked as { ownerUserId: string | null; ownerGuestSessionId: string | null });
  if (!locked) throw notFound();
  if ("expiresAt" in locked && !active(locked)) throw notFound();
  return rowFor(tx, principal, kind, id);
}

export async function listLibraryRows(db: Db, principal: Principal, kind: "document" | "comparison" | "thread", cursor: LibraryCursor | null, limit: number) {
  switch (kind) {
    case "document": {
      const table = schema.documents;
      const rows = await db.select(documentListColumns).from(table).where(and(
        principal.type === "user" ? eq(table.ownerUserId, principal.userId) : eq(table.ownerGuestSessionId, principal.guestSessionId),
        or(isNull(table.expiresAt), sql`${table.expiresAt} > now()`),
        validProject(table.projectId, table.ownerUserId),
        cursor ? or(sql`${table.updatedAt} < ${cursor.updatedAt}::timestamptz`, and(sql`${table.updatedAt} = ${cursor.updatedAt}::timestamptz`, lt(table.id, cursor.id))) : undefined,
      )).orderBy(desc(table.updatedAt), desc(table.id)).limit(limit + 1);
      return owned(rows, principal);
    }
    case "comparison": {
      const table = schema.comparisons;
      const rows = await db.select({ ...getTableColumns(table), cursorUpdatedAt: sql<string>`${table.updatedAt}::text` }).from(table).where(and(
        principal.type === "user" ? eq(table.ownerUserId, principal.userId) : eq(table.ownerGuestSessionId, principal.guestSessionId),
        or(isNull(table.expiresAt), sql`${table.expiresAt} > now()`),
        validProject(table.projectId, table.ownerUserId), validComparisonDocuments(),
        cursor ? or(sql`${table.updatedAt} < ${cursor.updatedAt}::timestamptz`, and(sql`${table.updatedAt} = ${cursor.updatedAt}::timestamptz`, lt(table.id, cursor.id))) : undefined,
      )).orderBy(desc(table.updatedAt), desc(table.id)).limit(limit + 1);
      return owned(rows, principal);
    }
    case "thread": {
      if (principal.type === "guest") return [];
      const table = schema.threads;
      const rows = await db.select({ ...getTableColumns(table), cursorUpdatedAt: sql<string>`${table.updatedAt}::text` }).from(table).where(and(
        eq(table.ownerUserId, principal.userId),
        validProject(table.projectId, table.ownerUserId),
        cursor ? or(sql`${table.updatedAt} < ${cursor.updatedAt}::timestamptz`, and(sql`${table.updatedAt} = ${cursor.updatedAt}::timestamptz`, lt(table.id, cursor.id))) : undefined,
      )).orderBy(desc(table.updatedAt), desc(table.id)).limit(limit + 1);
      return userOwned(rows, principal);
    }
  }
}

type DraftRow = typeof schema.drafts.$inferSelect;

// The root ancestor of `id`'s chain, via one recursive walk instead of a SELECT per generation.
// UNION (not UNION ALL) gives the same self-terminating guarantee the downward chain queries below
// rely on: a re-derived row is deduplicated away, so a malformed cycle can never loop forever — it
// just yields no root, which the caller below turns into a 404 like any other broken chain.
async function chainRootId(db: Db, id: string): Promise<string | null> {
  const result = await db.execute(sql`
    WITH RECURSIVE ancestors(id, parent_draft_id) AS (
      SELECT id, parent_draft_id FROM drafts WHERE id = ${id}::uuid
      UNION
      SELECT d.id, d.parent_draft_id FROM drafts d JOIN ancestors ON d.id = ancestors.parent_draft_id
    )
    SELECT id FROM ancestors WHERE parent_draft_id IS NULL
  `);
  return executeRows<{ id: string }>(result)[0]?.id ?? null;
}

/**
 * Loads and validates the full (ownership-unfiltered) descendant set of every id in `rootIds`, in a
 * fixed number of queries regardless of how many roots or how deep each one is: one recursive walk
 * for every member id, one batch select for their rows, one for every grounding document any of them
 * reference, one for every project any of them (or their grounding document) reference. A root whose
 * group comes back short (a row vanished), fails ownership/expiry, or references a foreign/missing
 * project or grounding document is dropped from the result entirely — never partially returned.
 */
async function loadValidatedChains(db: Db, principal: Principal, rootIds: readonly string[]): Promise<Map<string, DraftRow[]>> {
  const result = new Map<string, DraftRow[]>();
  const uniqueRoots = [...new Set(rootIds)];
  if (!uniqueRoots.length) return result;

  const idsResult = await db.execute(sql`
    WITH RECURSIVE chain(id, root_id) AS (
      SELECT id, id FROM drafts WHERE id IN (${sql.join(uniqueRoots.map((rootId) => sql`${rootId}::uuid`), sql`, `)})
      UNION
      SELECT d.id, chain.root_id FROM drafts d JOIN chain ON d.parent_draft_id = chain.id
    )
    SELECT id, root_id FROM chain
  `);
  const idRows = executeRows<{ id: string; root_id: string }>(idsResult);
  if (!idRows.length) return result;
  const rootOf = new Map(idRows.map((row) => [row.id, row.root_id]));
  const expectedCountByRoot = new Map<string, number>();
  for (const row of idRows) expectedCountByRoot.set(row.root_id, (expectedCountByRoot.get(row.root_id) ?? 0) + 1);

  const rows = await db.select().from(schema.drafts).where(inArray(schema.drafts.id, [...rootOf.keys()]))
    .orderBy(asc(schema.drafts.createdAt), asc(schema.drafts.id));
  const rowsByRoot = new Map<string, DraftRow[]>();
  for (const row of rows) {
    const rootId = rootOf.get(row.id);
    if (rootId === undefined) continue;
    (rowsByRoot.get(rootId) ?? rowsByRoot.set(rootId, []).get(rootId)!).push(row);
  }

  const invalid = new Set<string>();
  for (const [rootId, expectedCount] of expectedCountByRoot) {
    const group = rowsByRoot.get(rootId) ?? [];
    if (group.length !== expectedCount || group.some((row) => !canAccess(principal, row) || !active(row))) invalid.add(rootId);
  }

  const groundingIds = new Set<string>();
  for (const [rootId, group] of rowsByRoot) {
    if (invalid.has(rootId)) continue;
    for (const row of group) if (row.groundingDocumentId) groundingIds.add(row.groundingDocumentId);
  }
  const groundingById = new Map<string, { ownerUserId: string | null; ownerGuestSessionId: string | null; expiresAt: Date | null; projectId: string | null }>();
  if (groundingIds.size) {
    const groundingRows = await db.select({ id: schema.documents.id, ownerUserId: schema.documents.ownerUserId,
      ownerGuestSessionId: schema.documents.ownerGuestSessionId, expiresAt: schema.documents.expiresAt, projectId: schema.documents.projectId })
      .from(schema.documents).where(inArray(schema.documents.id, [...groundingIds]));
    for (const row of groundingRows) groundingById.set(row.id, row);
  }
  for (const [rootId, group] of rowsByRoot) {
    if (invalid.has(rootId)) continue;
    for (const row of group) {
      if (!row.groundingDocumentId) continue;
      const grounding = groundingById.get(row.groundingDocumentId);
      if (!grounding || !canAccess(principal, grounding) || !active(grounding)) invalid.add(rootId);
    }
  }

  const projectIdsByRoot = new Map<string, Set<string>>();
  for (const [rootId, group] of rowsByRoot) {
    if (invalid.has(rootId)) continue;
    const ids = new Set<string>();
    for (const row of group) {
      if (row.projectId) ids.add(row.projectId);
      const groundingProjectId = row.groundingDocumentId ? groundingById.get(row.groundingDocumentId)?.projectId : undefined;
      if (groundingProjectId) ids.add(groundingProjectId);
    }
    if (ids.size) projectIdsByRoot.set(rootId, ids);
  }
  const allProjectIds = new Set<string>();
  for (const ids of projectIdsByRoot.values()) for (const id of ids) allProjectIds.add(id);
  const projectOwnerById = new Map<string, string | null>();
  if (allProjectIds.size) {
    const projectRows = await db.select({ id: schema.projects.id, ownerUserId: schema.projects.ownerUserId })
      .from(schema.projects).where(inArray(schema.projects.id, [...allProjectIds]));
    for (const row of projectRows) projectOwnerById.set(row.id, row.ownerUserId);
  }
  for (const [rootId, ids] of projectIdsByRoot) {
    for (const id of ids) {
      const ownerUserId = projectOwnerById.get(id);
      if (ownerUserId === undefined || !canAccess(principal, { ownerUserId, ownerGuestSessionId: null })) invalid.add(rootId);
    }
  }

  for (const [rootId, group] of rowsByRoot) if (!invalid.has(rootId)) result.set(rootId, group);
  return result;
}

export async function listDraftChainsPage(db: Db, principal: Principal, cursor: LibraryCursor | null, limit: number) {
  const rootOwner = principal.type === "user" ? sql`d.owner_user_id = ${principal.userId}` : sql`d.owner_guest_session_id = ${principal.guestSessionId}`;
  const childOwner = principal.type === "user" ? sql`c.owner_user_id = ${principal.userId}` : sql`c.owner_guest_session_id = ${principal.guestSessionId}`;
  const valid: { row: typeof schema.drafts.$inferSelect; revisionCount: number; cursorUpdatedAt: string }[] = [];
  let position = cursor;
  while (valid.length <= limit) {
    const afterCursor = position ? sql`AND (updated_at, id) < (${position.updatedAt}::timestamptz, ${position.id}::uuid)` : sql``;
    const result = await db.execute(sql`
    WITH RECURSIVE chain (id, root_id) AS (
      SELECT d.id, d.id FROM drafts d
      WHERE d.parent_draft_id IS NULL AND ${rootOwner} AND (d.expires_at IS NULL OR d.expires_at > now())
      UNION ALL
      SELECT c.id, chain.root_id FROM drafts c JOIN chain ON c.parent_draft_id = chain.id
      WHERE ${childOwner} AND (c.expires_at IS NULL OR c.expires_at > now())
    ), ranked AS (
      SELECT d.id, d.updated_at, chain.root_id, count(*) OVER (PARTITION BY chain.root_id)::int AS revision_count,
             row_number() OVER (PARTITION BY chain.root_id ORDER BY d.created_at DESC, d.id DESC) AS position
      FROM chain JOIN drafts d ON d.id = chain.id
    )
    SELECT id, revision_count, updated_at::text AS cursor_updated_at, root_id FROM ranked WHERE position = 1 ${afterCursor}
    ORDER BY updated_at DESC, id DESC LIMIT ${limit + 1}
  `);
    const entries = executeRows<{ id: string; revision_count: number; cursor_updated_at: string; root_id: string }>(result);
    if (entries.length === 0) break;
    // One batched load/validation for every candidate chain on this page, not one draftChain() call
    // per row — the project/grounding-document checks the ranked query above can't express in SQL
    // still run, just once per referenced id instead of once per row that references it.
    const validated = await loadValidatedChains(db, principal, entries.map((entry) => entry.root_id));
    for (const entry of entries) {
      position = { updatedAt: entry.cursor_updated_at, id: entry.id };
      const chain = validated.get(entry.root_id);
      const row = chain?.find((draft) => draft.id === entry.id);
      if (row) valid.push({ row, revisionCount: chain!.length, cursorUpdatedAt: entry.cursor_updated_at });
      if (valid.length > limit) break;
    }
    if (entries.length < limit + 1) break;
  }
  return valid;
}

export async function getLibraryRow(db: Db, principal: Principal, kind: LibraryKind, id: string) {
  return rowFor(db, principal, kind, id);
}

export async function draftChain(db: Db, principal: Principal, id: string) {
  const current = await rowFor(db, principal, "draft", id);
  if (!("parentDraftId" in current)) throw notFound();
  // A root revision is its own chain root — skips the ancestor walk for the common case (a draft
  // with no revisions yet), which lockDraftChain's three draftChain() calls would otherwise triple.
  const rootId = current.parentDraftId === null ? current.id : await chainRootId(db, id);
  const validated = rootId === null ? new Map<string, DraftRow[]>() : await loadValidatedChains(db, principal, [rootId]);
  const chain = rootId === null ? undefined : validated.get(rootId);
  if (!chain || !chain.some((draft) => draft.id === id)) throw notFound();
  return chain;
}

export async function lockDraftChain(tx: Db, principal: Principal, id: string) {
  const initial = await draftChain(tx, principal, id);
  const root = initial.find((row) => row.parentDraftId === null);
  if (!root) throw notFound();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`draft-chain:${root.id}`}, 0))`);
  const chain = await draftChain(tx, principal, id);
  for (const draftId of sweepOrderOfDrafts(chain)) {
    const [locked] = await tx.select().from(schema.drafts).where(eq(schema.drafts.id, draftId)).for("update");
    assertCanAccess(principal, locked);
    if (!locked || !active(locked)) throw notFound();
  }
  return draftChain(tx, principal, id);
}

function cleanTitle(value: string, max: number): string {
  const title = value.toWellFormed().replace(/\p{Cc}|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").trim();
  if (!title || Array.from(title).length > max) throw new AppError("VALIDATION_FAILED", "Invalid title.");
  return title;
}

export async function renameLibraryRow(db: Db, principal: Principal, kind: LibraryKind, id: string, value: string) {
  const title = cleanTitle(value, kind === "project" ? 255 : 120);
  if (kind === "draft") {
    return db.transaction(async (tx) => {
      const chain = await lockDraftChain(tx, principal, id);
      await tx.update(schema.drafts).set({ title, updatedAt: sql`now()` }).where(inArray(schema.drafts.id, chain.map((row) => row.id)));
      return rowFor(tx, principal, "draft", id);
    });
  }
  return db.transaction(async (tx) => {
    await lockCurrentRow(tx, principal, kind, id);
    switch (kind) {
      case "document": return (await tx.update(schema.documents).set({ title, updatedAt: sql`now()` }).where(eq(schema.documents.id, id)).returning())[0];
      case "comparison": return (await tx.update(schema.comparisons).set({ title, updatedAt: sql`now()` }).where(eq(schema.comparisons.id, id)).returning())[0];
      case "thread": return (await tx.update(schema.threads).set({ title, updatedAt: sql`now()` }).where(eq(schema.threads.id, id)).returning())[0];
      case "project": return (await tx.update(schema.projects).set({ name: title, updatedAt: sql`now()` }).where(eq(schema.projects.id, id)).returning())[0];
    }
  });
}

export async function unassignLibraryRow(db: Db, principal: Principal, kind: Exclude<LibraryKind, "project">, id: string) {
  if (kind === "draft") {
    return db.transaction(async (tx) => {
      const chain = await lockDraftChain(tx, principal, id);
      await tx.update(schema.drafts).set({ projectId: null, updatedAt: sql`now()` }).where(inArray(schema.drafts.id, chain.map((row) => row.id)));
      return rowFor(tx, principal, "draft", id);
    });
  }
  return db.transaction(async (tx) => {
    await lockCurrentRow(tx, principal, kind, id);
    switch (kind) {
      case "document": return (await tx.update(schema.documents).set({ projectId: null, updatedAt: sql`now()` }).where(eq(schema.documents.id, id)).returning())[0];
      case "comparison": return (await tx.update(schema.comparisons).set({ projectId: null, updatedAt: sql`now()` }).where(eq(schema.comparisons.id, id)).returning())[0];
      case "thread": return (await tx.update(schema.threads).set({ projectId: null, updatedAt: sql`now()` }).where(eq(schema.threads.id, id)).returning())[0];
    }
  });
}

async function assertDocumentReferencesOwned(db: Db, principal: Principal, id: string) {
  // Four independent reads (different tables, all keyed on the same document id) — run together
  // instead of round-tripping one at a time.
  const [comparisons, drafts, threadLinks, citationThreads] = await Promise.all([
    db.select().from(schema.comparisons).where(or(eq(schema.comparisons.documentAId, id), eq(schema.comparisons.documentBId, id))),
    db.select().from(schema.drafts).where(eq(schema.drafts.groundingDocumentId, id)),
    db.select({ threadId: schema.threads.id, ownerUserId: schema.threads.ownerUserId }).from(schema.threadDocuments)
      .innerJoin(schema.threads, eq(schema.threadDocuments.threadId, schema.threads.id))
      .where(eq(schema.threadDocuments.documentId, id)),
    db.select({ threadId: schema.threads.id, ownerUserId: schema.threads.ownerUserId }).from(schema.messageCitations)
      .innerJoin(schema.messages, eq(schema.messageCitations.messageId, schema.messages.id))
      .innerJoin(schema.threads, eq(schema.messages.threadId, schema.threads.id))
      .where(eq(schema.messageCitations.sourceDocumentId, id)),
  ]);
  if (comparisons.some((row) => !canAccess(principal, row)) || drafts.some((row) => !canAccess(principal, row)) ||
    [...threadLinks, ...citationThreads].some((row) => !canAccess(principal, { ownerUserId: row.ownerUserId, ownerGuestSessionId: null }))) {
    throw notFound();
  }
  for (const comparison of comparisons) await rowFor(db, principal, "comparison", comparison.id);
  for (const draft of drafts) await draftChain(db, principal, draft.id);
  for (const thread of [...threadLinks, ...citationThreads]) await rowFor(db, principal, "thread", thread.threadId);
  return { comparisons: comparisons.length, draftsUngrounded: drafts.length, threadsUnlinked: threadLinks.length };
}

async function lockDocumentDependents(tx: Db, id: string) {
  await tx.select({ id: schema.comparisons.id }).from(schema.comparisons)
    .where(or(eq(schema.comparisons.documentAId, id), eq(schema.comparisons.documentBId, id)))
    .orderBy(asc(schema.comparisons.id)).for("update");
  const drafts = await tx.select({ id: schema.drafts.id, parentDraftId: schema.drafts.parentDraftId })
    .from(schema.drafts).where(eq(schema.drafts.groundingDocumentId, id));
  for (const draftId of sweepOrderOfDrafts(drafts)) {
    await tx.select({ id: schema.drafts.id }).from(schema.drafts)
      .where(eq(schema.drafts.id, draftId)).for("update");
  }
}

async function assertProjectItemsOwned(db: Db, principal: Principal, id: string) {
  const [documents, comparisons, drafts, threads] = await Promise.all([
    db.select({ ownerUserId: schema.documents.ownerUserId, ownerGuestSessionId: schema.documents.ownerGuestSessionId })
      .from(schema.documents).where(eq(schema.documents.projectId, id)),
    db.select({ ownerUserId: schema.comparisons.ownerUserId, ownerGuestSessionId: schema.comparisons.ownerGuestSessionId })
      .from(schema.comparisons).where(eq(schema.comparisons.projectId, id)),
    db.select({ ownerUserId: schema.drafts.ownerUserId, ownerGuestSessionId: schema.drafts.ownerGuestSessionId })
      .from(schema.drafts).where(eq(schema.drafts.projectId, id)),
    db.select({ ownerUserId: schema.threads.ownerUserId }).from(schema.threads).where(eq(schema.threads.projectId, id)),
  ]);
  if ([...documents, ...comparisons, ...drafts].some((row) => !canAccess(principal, row)) ||
    threads.some((row) => !canAccess(principal, { ownerUserId: row.ownerUserId, ownerGuestSessionId: null }))) {
    throw notFound();
  }
}

export async function documentDeleteImpact(db: Db, principal: Principal, id: string) {
  await rowFor(db, principal, "document", id);
  return assertDocumentReferencesOwned(db, principal, id);
}

export async function deleteLibraryRow(db: Db, principal: Principal, kind: LibraryKind, id: string) {
  return db.transaction(async (tx) => {
    if (kind === "document") {
      await rowFor(tx, principal, kind, id);
      await lockDocumentDependents(tx, id);
    }
    const row = kind === "draft" ? (await lockDraftChain(tx, principal, id)).find((draft) => draft.id === id)! : await lockCurrentRow(tx, principal, kind, id);
    if (kind === "document") {
      await assertDocumentReferencesOwned(tx, principal, id);
      if (row && "storageRef" in row) await tx.insert(schema.storageCleanupOutbox).values({ storageRef: row.storageRef }).onConflictDoNothing();
      await tx.delete(schema.comparisons).where(or(eq(schema.comparisons.documentAId, id), eq(schema.comparisons.documentBId, id)));
      await tx.delete(schema.documents).where(eq(schema.documents.id, id));
      return row;
    }
    if (kind === "draft") {
      const chain = await draftChain(tx, principal, id);
      for (const draft of [...chain].sort((a, b) => b.revisionNumber - a.revisionNumber)) {
        await tx.delete(schema.drafts).where(eq(schema.drafts.id, draft.id));
      }
      return row;
    }
    if (kind === "comparison") await tx.delete(schema.comparisons).where(eq(schema.comparisons.id, id));
    if (kind === "thread") await tx.delete(schema.threads).where(eq(schema.threads.id, id));
    if (kind === "project") {
      await assertProjectItemsOwned(tx, principal, id);
      await tx.update(schema.documents).set({ updatedAt: sql`now()` }).where(eq(schema.documents.projectId, id));
      await tx.update(schema.comparisons).set({ updatedAt: sql`now()` }).where(eq(schema.comparisons.projectId, id));
      await tx.update(schema.drafts).set({ updatedAt: sql`now()` }).where(eq(schema.drafts.projectId, id));
      await tx.update(schema.threads).set({ updatedAt: sql`now()` }).where(eq(schema.threads.projectId, id));
      await tx.delete(schema.projects).where(eq(schema.projects.id, id));
    }
    return row;
  });
}

export async function deleteAllLibraryRows(db: Db, principal: Principal) {
  return db.transaction(async (tx) => {
    // Projects first: saveToProject locks its project before the item rows and draft chain, so
    // locking projects last here would invert that order and let the two deadlock.
    const projects = principal.type === "user" ? userOwned(await tx.select().from(schema.projects)
      .where(eq(schema.projects.ownerUserId, principal.userId)).orderBy(asc(schema.projects.id)).for("update"), principal) : [];
    const draftOwner = principal.type === "user" ? eq(schema.drafts.ownerUserId, principal.userId) : eq(schema.drafts.ownerGuestSessionId, principal.guestSessionId);
    const roots = await tx.select({ id: schema.drafts.id }).from(schema.drafts)
      .where(and(draftOwner, isNull(schema.drafts.parentDraftId))).orderBy(asc(schema.drafts.id));
    for (const root of roots) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`draft-chain:${root.id}`}, 0))`);
    const comparisons = owned(await tx.select().from(schema.comparisons)
      .where(principal.type === "user" ? eq(schema.comparisons.ownerUserId, principal.userId) : eq(schema.comparisons.ownerGuestSessionId, principal.guestSessionId))
      .orderBy(asc(schema.comparisons.id)).for("update"), principal);
    const draftSnapshot = await tx.select({ id: schema.drafts.id, parentDraftId: schema.drafts.parentDraftId }).from(schema.drafts).where(draftOwner);
    const drafts: (typeof schema.drafts.$inferSelect)[] = [];
    for (const draftId of sweepOrderOfDrafts(draftSnapshot)) {
      const [locked] = await tx.select().from(schema.drafts).where(eq(schema.drafts.id, draftId)).for("update");
      if (locked && canAccess(principal, locked)) drafts.push(locked);
    }
    const documents = owned(await tx.select(documentListColumns).from(schema.documents)
      .where(principal.type === "user" ? eq(schema.documents.ownerUserId, principal.userId) : eq(schema.documents.ownerGuestSessionId, principal.guestSessionId))
      .orderBy(asc(schema.documents.id)).for("update"), principal);
    const threads = principal.type === "user" ? userOwned(await tx.select().from(schema.threads)
      .where(eq(schema.threads.ownerUserId, principal.userId)).orderBy(asc(schema.threads.id)).for("update"), principal) : [];
    for (const comparison of comparisons) await rowFor(tx, principal, "comparison", comparison.id);
    for (const draft of drafts) await draftChain(tx, principal, draft.id);
    for (const thread of threads) await rowFor(tx, principal, "thread", thread.id);
    for (const document of documents) {
      await rowFor(tx, principal, "document", document.id);
      await assertDocumentReferencesOwned(tx, principal, document.id);
    }
    for (const project of projects) {
      await assertProjectItemsOwned(tx, principal, project.id);
    }
    if (documents.length) await tx.insert(schema.storageCleanupOutbox).values(documents.map((row) => ({ storageRef: row.storageRef }))).onConflictDoNothing();
    if (comparisons.length) await tx.delete(schema.comparisons).where(inArray(schema.comparisons.id, comparisons.map((row) => row.id)));
    if (drafts.length) for (const draft of [...drafts].sort((a, b) => b.revisionNumber - a.revisionNumber)) await tx.delete(schema.drafts).where(eq(schema.drafts.id, draft.id));
    if (threads.length) await tx.delete(schema.threads).where(inArray(schema.threads.id, threads.map((row) => row.id)));
    if (documents.length) await tx.delete(schema.documents).where(inArray(schema.documents.id, documents.map((row) => row.id)));
    if (projects.length) await tx.delete(schema.projects).where(inArray(schema.projects.id, projects.map((row) => row.id)));
    return { deleted: { documents: documents.length, comparisons: comparisons.length, drafts: drafts.length, threads: threads.length, projects: projects.length }, storageRows: documents };
  });
}
