/**
 * The local adapter's per-upload files, kept in the upload's own uuid directory beside its object:
 * the upload record (what createUploadTarget was told) and the one-shot confirm marker. Both names
 * contain "@", outside sanitizeFilename's allowlist, so no upload's own filename can collide with
 * them. Also the sweep that deletes uploads never confirmed.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ConfirmedUpload } from "./types";

/** Written exclusive-create when confirmUpload first succeeds, so one object never backs two documents. */
export const CONFIRMED_MARKER_FILENAME = "@confirmed";
/** Written exclusive-create by createUploadTarget; its mtime is when the target was created. */
export const UPLOAD_RECORD_FILENAME = "@upload.json";

// Only directories shaped like a ref's first two segments are ever swept, so a misconfigured root
// can't lose anything else.
const OWNER_DIR_RE = /^(?:user|guest):[a-z0-9_-]+$/;
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Records what an upload was declared as, in the upload's own directory (`objectPath`'s parent). */
export async function writeUploadRecord(objectPath: string, record: ConfirmedUpload): Promise<void> {
  await fs.mkdir(path.dirname(objectPath), { recursive: true });
  await fs.writeFile(path.join(path.dirname(objectPath), UPLOAD_RECORD_FILENAME), JSON.stringify(record), { flag: "wx" });
}

/** The upload's record and when its target was created, or null when it has none. */
export async function readUploadRecord(objectPath: string): Promise<{ record: ConfirmedUpload; createdAt: Date } | null> {
  const recordPath = path.join(path.dirname(objectPath), UPLOAD_RECORD_FILENAME);
  try {
    const [text, stat] = await Promise.all([fs.readFile(recordPath, "utf8"), fs.stat(recordPath)]);
    const { filename, mimeType } = JSON.parse(text) as ConfirmedUpload;
    return { record: { filename, mimeType }, createdAt: stat.mtime };
  } catch {
    return null;
  }
}

// A path deleted while the sweep runs (by another sweep, a purge, or a test's teardown) is simply
// gone: ENOENT reads as "nothing here", never as a failed sweep.
function orIfGone<T>(gone: T) {
  return (error: NodeJS.ErrnoException): T => {
    if (error.code === "ENOENT") return gone;
    throw error;
  };
}

async function subdirectories(dir: string, name: RegExp): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(orIfGone([]));
  return entries.filter((entry) => entry.isDirectory() && name.test(entry.name)).map((entry) => path.join(dir, entry.name));
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, orIfGone(false));
}

// The record's mtime, or the directory's for an upload with no record; null once the upload is gone.
async function createdAt(uploadDir: string): Promise<Date | null> {
  const record = await fs.stat(path.join(uploadDir, UPLOAD_RECORD_FILENAME)).catch(orIfGone(null));
  if (record !== null) return record.mtime;
  return (await fs.stat(uploadDir).catch(orIfGone(null)))?.mtime ?? null;
}

/**
 * Deletes every upload under `rootDir` that was never confirmed and whose target was created before
 * `createdBefore` — its record's mtime, or the directory's for an upload with no record. Returns how
 * many it deleted.
 */
export async function sweepUnconfirmedUploads(rootDir: string, createdBefore: Date): Promise<number> {
  let swept = 0;
  for (const ownerDir of await subdirectories(rootDir, OWNER_DIR_RE)) {
    for (const uploadDir of await subdirectories(ownerDir, UUID_DIR_RE)) {
      if (await exists(path.join(uploadDir, CONFIRMED_MARKER_FILENAME))) continue;
      const created = await createdAt(uploadDir);
      if (created === null || created >= createdBefore) continue;
      await fs.rm(uploadDir, { recursive: true, force: true });
      swept++;
    }
  }
  return swept;
}
