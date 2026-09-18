/**
 * System-only storage purge. See `StoragePurger` in ./types.ts for why this is a wholly separate
 * object rather than an extra method on `LocalFsStorageAdapter`: the TTL sweep has no calling
 * principal, unlike the principal- and current-owner-scoped `StorageAdapter.delete`. Never construct
 * this or hand it to a route handler or service — only a sweep job should ever hold one.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_ROOT_DIR } from "./local-fs-adapter";
import { refToPath } from "./refs";
import type { StoragePurger } from "./types";
import { sweepUnconfirmedUploads } from "./upload-records";

/** Constructor options for LocalFsStoragePurger. */
export interface LocalFsStoragePurgerOptions {
  rootDir?: string;
}

/** The TTL sweep's local-filesystem purger; deletes storage objects by ref with no authorization check. */
export class LocalFsStoragePurger implements StoragePurger {
  private readonly rootDir: string;

  constructor(options: LocalFsStoragePurgerOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  }

  /** Fails loud on a malformed ref (refToPath throws) rather than silently skipping it — a malformed one reaching here means something upstream is already wrong. */
  async purge(refs: string[]): Promise<void> {
    for (const ref of refs) {
      const target = refToPath(this.rootDir, ref);
      // Removes the whole uuid directory — the object and its one-shot confirm marker together, not
      // just the object file — since nothing legitimate should ever reuse this ref once it's purged.
      await fs.rm(path.dirname(target), { recursive: true, force: true });
    }
  }

  /** Deletes every upload never confirmed whose target was created before `createdBefore`; returns how many. */
  purgeUnconfirmedUploads(createdBefore: Date): Promise<number> {
    return sweepUnconfirmedUploads(this.rootDir, createdBefore);
  }
}
