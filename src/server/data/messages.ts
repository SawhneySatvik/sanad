/**
 * Messages repository. `listRecentMessages` returns the last N messages, not the oldest N. `messages.id`
 * is a UUIDv7 the app supplies (src/db/ids.ts), never a DB default, making `created_at DESC, id DESC`
 * a deterministic tie-break even for messages inserted in the same millisecond or transaction.
 */

import { desc, eq, sql } from "drizzle-orm";
import { newId } from "../../db/ids";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { getThread } from "./threads";

/** A persisted message row, as read from the database. */
export type Message = typeof schema.messages.$inferSelect;

/**
 * A user message can never carry `mode`/`routedDomains`/`modelUsed` at the type level, and an
 * assistant message must always carry `mode` and `modelUsed` — matching the DB's CHECKs exactly, so a
 * caller can't construct an invalid combination that only fails at the database.
 */
export type AppendMessageInput =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      mode: "grounded" | "general";
      modelUsed: string;
      routedDomains?: string[] | null;
    };

/** A hard ceiling independent of whatever a caller passes — never an unbounded LIMIT driven by client input. */
export const MAX_RECENT_MESSAGES_LIMIT = 200;

// Postgres SQLSTATE for a foreign-key violation: a thread deleted in the narrow window between
// appendMessage's getThread() check and its INSERT (a race, not an IDOR) fails the INSERT this way —
// this guard turns that into the same NOT_FOUND every other disappearing-thread path produces.
// drizzle-orm wraps the real pg error in `.cause`, not always a top-level `.code` — checked both places.
const FOREIGN_KEY_VIOLATION = "23503";
function pgErrorCode(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  const withCode = err as { code?: unknown; cause?: { code?: unknown } };
  return withCode.code ?? withCode.cause?.code;
}
function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === FOREIGN_KEY_VIOLATION;
}

/** Appends a message to a thread and bumps the thread's updated_at, atomically. */
export async function appendMessage(
  db: Db,
  principal: Principal,
  threadId: string,
  input: AppendMessageInput,
): Promise<Message> {
  await getThread(db, principal, threadId); // authorizes; throws NOT_FOUND for foreign/missing

  // Transaction (DB-only, no LLM call spans it): the message insert and the thread's `updated_at`
  // bump — so listThreads' recency ordering reflects the latest activity, not just rename/create —
  // must both land or neither does.
  return db.transaction(async (tx) => {
    let row: Message;
    try {
      [row] = await tx
        .insert(schema.messages)
        .values(
          input.role === "user"
            ? { id: newId(), threadId, role: "user", content: input.content, mode: null, routedDomainArray: null, modelUsed: null }
            : {
                id: newId(),
                threadId,
                role: "assistant",
                content: input.content,
                mode: input.mode,
                routedDomainArray: input.routedDomains ?? null,
                modelUsed: input.modelUsed,
              },
        )
        .returning();
    } catch (err) {
      if (isForeignKeyViolation(err)) throw notFound();
      throw err;
    }
    await tx.update(schema.threads).set({ updatedAt: sql`now()` }).where(eq(schema.threads.id, threadId));
    return row;
  });
}

/**
 * The last `limit` messages in chronological order: `ORDER BY created_at DESC, id DESC LIMIT :limit`,
 * then reversed for display. Never an ASC query with a LIMIT, which would return the oldest N
 * instead of the latest N.
 */
export async function listRecentMessages(
  db: Db,
  principal: Principal,
  threadId: string,
  limit: number,
): Promise<Message[]> {
  await getThread(db, principal, threadId); // authorizes; throws NOT_FOUND for foreign/missing

  // Number.isFinite guards NaN/Infinity/-Infinity: Math.trunc(NaN) is NaN,
  // which would sail past Math.min/Math.max unclamped and either reach the
  // query as an invalid LIMIT or (worse) silently fail open to "no limit".
  const cappedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), MAX_RECENT_MESSAGES_LIMIT)) : 0;
  if (cappedLimit === 0) return [];

  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.threadId, threadId))
    .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
    .limit(cappedLimit);

  return rows.reverse();
}
