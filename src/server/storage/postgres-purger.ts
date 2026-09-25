/**
 * System-only storage purge for the Postgres-backed adapter. See `StoragePurger` in ./types.ts for
 * why this is a wholly separate object rather than an extra method on `PostgresStorageAdapter`: the
 * TTL sweep has no calling principal, unlike the principal- and current-owner-scoped
 * `StorageAdapter.delete`. Never construct this or hand it to a route handler or service — only a
 * sweep job should ever hold one.
 */

import { and, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "../../db/client";
import { storageObjects } from "../../db/schema";
import type { StoragePurger } from "./types";

/**
 * Deletes every upload never confirmed whose target was created before `createdBefore`; returns how
 * many. Exported standalone (mirrors upload-records.ts's own sweepUnconfirmedUploads) so
 * PostgresStorageAdapter can also run it opportunistically off createUploadTarget, without holding a
 * StoragePurger instance itself.
 */
export async function sweepUnconfirmedUploads(db: Db, createdBefore: Date): Promise<number> {
  const deleted = await db
    .delete(storageObjects)
    .where(and(isNull(storageObjects.confirmedAt), lt(storageObjects.createdAt, createdBefore)))
    .returning({ storageRef: storageObjects.storageRef });
  return deleted.length;
}

/** Constructor options for PostgresStoragePurger. */
export interface PostgresStoragePurgerOptions {
  db: Db;
}

/** The TTL sweep's Postgres purger; deletes storage_objects rows by ref with no authorization check. */
export class PostgresStoragePurger implements StoragePurger {
  private readonly db: Db;

  constructor(options: PostgresStoragePurgerOptions) {
    this.db = options.db;
  }

  /** A ref with no matching row is simply not there to delete — no error, same as the local purger's `force: true` unlink. */
  async purge(refs: string[]): Promise<void> {
    if (refs.length === 0) return;
    await this.db.delete(storageObjects).where(inArray(storageObjects.storageRef, refs));
  }

  purgeUnconfirmedUploads(createdBefore: Date): Promise<number> {
    return sweepUnconfirmedUploads(this.db, createdBefore);
  }
}
