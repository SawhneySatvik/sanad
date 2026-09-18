/**
 * Threads repository. Every exported function authorizes through canAccess before touching a row.
 * `threads.owner_user_id` is NOT NULL: a guest principal can never create one, and its active thread
 * lives entirely client-side (see ../../lib/guest-thread-store.ts).
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { assertCanAccess, assertCanAccessAll, type OwnedResource } from "./access";

/** A persisted thread row, as read from the database. */
export type Thread = typeof schema.threads.$inferSelect;

// A malformed id must 404 exactly like a foreign/missing one — never a raw Postgres "invalid input
// syntax for type uuid" 500, which would be a distinguishable-existence oracle. Checked before any
// query — an invalid id never even reaches the database.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function isUuidShaped(value: string): boolean {
  return UUID_RE.test(value);
}

/** Fields required to create a new thread. */
export interface CreateThreadInput {
  title: string;
  projectId?: string;
}

/** Filter for listThreads. */
export interface ListThreadsFilter {
  projectId?: string;
}

function threadOwnedResource(row: Pick<Thread, "ownerUserId"> | undefined): OwnedResource | undefined {
  return row ? { ownerUserId: row.ownerUserId, ownerGuestSessionId: null } : undefined;
}

// An UPDATE ... RETURNING that matches zero rows doesn't throw, it just returns empty. Without this,
// a thread deleted in the narrow window between renameThread's own check and its UPDATE would return
// `undefined` typed as `Thread`, instead of the same NOT_FOUND every other disappearing-row path produces.
function firstOrNotFound<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (!row) throw notFound();
  return row;
}

// Threads are exclusively user-owned — a guest principal is refused before any row is touched, never
// silently given a guest-owned thread row (which the schema doesn't even have a column for).
function assertUserPrincipal(principal: Principal): asserts principal is { type: "user"; userId: string } {
  if (principal.type !== "user") {
    throw new AppError(
      "VALIDATION_FAILED",
      "Guest sessions cannot create a thread — guest threads are client-side only until saved.",
    );
  }
}

/** Creates a thread for a user principal; throws for a guest. */
export async function createThread(db: Db, principal: Principal, input: CreateThreadInput): Promise<Thread> {
  assertUserPrincipal(principal);

  if (input.projectId !== undefined) {
    const [project] = isUuidShaped(input.projectId)
      ? await db
          .select({ ownerUserId: schema.projects.ownerUserId })
          .from(schema.projects)
          .where(eq(schema.projects.id, input.projectId))
      : [];
    // Multi-entity rule: owning the thread-to-be isn't enough — the principal must also own the
    // project it's scoped to.
    assertCanAccessAll(principal, [project ? { ownerUserId: project.ownerUserId, ownerGuestSessionId: null } : undefined]);
  }

  const [row] = await db
    .insert(schema.threads)
    .values({ ownerUserId: principal.userId, projectId: input.projectId ?? null, title: input.title })
    .returning();
  return row;
}

/** Fetches a thread by id. */
export async function getThread(db: Db, principal: Principal, threadId: string): Promise<Thread> {
  const [row] = isUuidShaped(threadId)
    ? await db.select().from(schema.threads).where(eq(schema.threads.id, threadId))
    : [];
  // A foreign thread, a missing thread, and a malformed id all 404 identically — canAccess treats a
  // mismatched owner and an absent resource the same way, and the UUID-shape guard above never lets a
  // malformed id reach the query in the first place.
  assertCanAccess(principal, threadOwnedResource(row));
  return row;
}

/** Every thread `principal` owns, optionally filtered by project, most recently updated first. */
export async function listThreads(db: Db, principal: Principal, filter: ListThreadsFilter = {}): Promise<Thread[]> {
  // No thread row can ever belong to a guest — an empty list is the correct, harmless answer rather
  // than a type-unsafe query against a column a guest principal has no id for.
  if (principal.type !== "user") return [];
  // A malformed (non-UUID) filter.projectId must 404-shaped-empty like every other
  // client-suppliable id, not reach Postgres and 500. Guarded the same way getThread/attachDocument are.
  if (filter.projectId !== undefined && !isUuidShaped(filter.projectId)) return [];

  const conditions = [eq(schema.threads.ownerUserId, principal.userId)];
  if (filter.projectId !== undefined) conditions.push(eq(schema.threads.projectId, filter.projectId));

  return db
    .select()
    .from(schema.threads)
    .where(and(...conditions))
    // id DESC tie-break — two threads updated in the same millisecond must still sort
    // deterministically, the same reasoning messages.ts's listRecentMessages already applies.
    .orderBy(desc(schema.threads.updatedAt), desc(schema.threads.id));
}

/** Renames a thread and bumps its updated_at. */
export async function renameThread(db: Db, principal: Principal, threadId: string, title: string): Promise<Thread> {
  await getThread(db, principal, threadId); // authorizes; throws NOT_FOUND for foreign/missing
  const rows = await db
    .update(schema.threads)
    .set({ title, updatedAt: sql`now()` })
    .where(eq(schema.threads.id, threadId))
    .returning();
  return firstOrNotFound(rows);
}

/** Deletes a thread. */
export async function deleteThread(db: Db, principal: Principal, threadId: string): Promise<void> {
  await getThread(db, principal, threadId); // authorizes; throws NOT_FOUND for foreign/missing
  // messages/thread_documents CASCADE on threads.id — no manual child cleanup needed here.
  await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
}

/** Attaches a document to a thread; no-op if already attached. */
export async function attachDocument(
  db: Db,
  principal: Principal,
  threadId: string,
  documentId: string,
): Promise<void> {
  const [thread] = isUuidShaped(threadId)
    ? await db
        .select({ ownerUserId: schema.threads.ownerUserId })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId))
    : [];
  // Minimal select straight off `documents`, not through documents.ts's own accessors — this check
  // only needs the owner columns, not a full document summary.
  const [document] = isUuidShaped(documentId)
    ? await db
        .select({ ownerUserId: schema.documents.ownerUserId, ownerGuestSessionId: schema.documents.ownerGuestSessionId })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentId))
    : [];

  // Multi-entity rule: the principal must own both the thread and the document, not just the primary
  // (thread) side.
  assertCanAccessAll(principal, [
    threadOwnedResource(thread),
    document ? { ownerUserId: document.ownerUserId, ownerGuestSessionId: document.ownerGuestSessionId } : undefined,
  ]);

  await db
    .insert(schema.threadDocuments)
    .values({ threadId, documentId })
    .onConflictDoNothing();
}

/** Attached document ids for a thread, oldest first; the caller loads each through the documents repository, which authorizes it again. */
export async function listThreadDocumentIds(db: Db, principal: Principal, threadId: string): Promise<string[]> {
  await getThread(db, principal, threadId); // authorizes; throws NOT_FOUND for foreign/missing
  const rows = await db
    .select({ documentId: schema.threadDocuments.documentId })
    .from(schema.threadDocuments)
    .where(eq(schema.threadDocuments.threadId, threadId))
    .orderBy(asc(schema.threadDocuments.attachedAt), asc(schema.threadDocuments.documentId));
  return rows.map((row) => row.documentId);
}
