import type { Db } from "../../db/client";
import { pendingStorageCleanup, processQueuedStorageRef } from "../data/library";
import type { StoragePurger } from "./types";

export const STORAGE_CLEANUP_BATCH_LIMIT = 50;

export async function runStorageCleanupBatch(db: Db, purger: StoragePurger, limit = STORAGE_CLEANUP_BATCH_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > STORAGE_CLEANUP_BATCH_LIMIT) {
    throw new RangeError("Invalid storage cleanup batch limit.");
  }
  const entries = await pendingStorageCleanup(db, limit);
  let purged = 0;
  let live = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      const outcome = await processQueuedStorageRef(db, entry.storageRef, () => purger.purge([entry.storageRef]));
      if (outcome === "live") live += 1;
      if (outcome === "purged") purged += 1;
      if (outcome === "failed") failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { selected: entries.length, purged, live, failed };
}
