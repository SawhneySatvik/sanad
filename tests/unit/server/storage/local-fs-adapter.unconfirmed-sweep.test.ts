import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/server/core/types";
import { LocalFsStorageAdapter, UNCONFIRMED_SWEEP_INTERVAL_MS } from "@/server/storage/local-fs-adapter";
import { UNCONFIRMED_UPLOAD_TTL_MS } from "@/server/storage/policy";
import { LocalFsStoragePurger } from "@/server/storage/purger";
import { UPLOAD_RECORD_FILENAME } from "@/server/storage/upload-records";

// An upload never confirmed belongs to no row, so the TTL sweep's expired-row query never finds
// it. The purger deletes those past a cutoff, and createUploadTarget starts that sweep itself, at
// most once per interval and without waiting for it — on uploads unconfirmable for at least one
// interval. Tests await the adapter's lastSweep before looking at the disk.

const GUEST: Principal = { type: "guest", guestSessionId: "sweep-guest" };
const OTHER: Principal = { type: "user", userId: "sweep-user" };
const BYTES = Buffer.from("fifteen megabytes, in spirit");

let rootDir: string;
beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "unconfirmed-sweep-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(rootDir, 0o755).catch(() => undefined);
  await fs.rm(rootDir, { recursive: true, force: true });
});

function adapter(): LocalFsStorageAdapter {
  return new LocalFsStorageAdapter({ rootDir, accessCheck: () => true, signingSecret: "unconfirmed-sweep-signing-secret-0123" });
}

async function upload(storage: LocalFsStorageAdapter, principal: Principal, options: { write?: boolean; confirm?: boolean; ageMs?: number } = {}) {
  const target = await storage.createUploadTarget(principal, { filename: "lease.txt", mimeType: "text/plain", sizeBytes: BYTES.byteLength });
  await storage.lastSweep;
  if (options.write ?? true) await storage.writeRelayed(principal, target.ref, BYTES);
  if (options.confirm) await storage.confirmUpload(principal, target.ref);
  const uploadDir = path.join(rootDir, ...target.ref.split("/").slice(0, 2));
  if (options.ageMs !== undefined) {
    const created = new Date(Date.now() - options.ageMs);
    await fs.utimes(path.join(uploadDir, UPLOAD_RECORD_FILENAME), created, created);
  }
  return uploadDir;
}

const present = (dir: string) => fs.stat(dir).then(() => true, () => false);

describe("LocalFsStoragePurger.purgeUnconfirmedUploads", () => {
  it("deletes unconfirmed uploads created before the cutoff — written or not — and nothing else", async () => {
    const storage = adapter();
    const hour = 60 * 60 * 1000;
    const oldWritten = await upload(storage, GUEST, { ageMs: hour });
    const oldNeverWritten = await upload(storage, OTHER, { write: false, ageMs: hour });
    const oldConfirmed = await upload(storage, GUEST, { confirm: true });
    await fs.utimes(path.join(oldConfirmed, UPLOAD_RECORD_FILENAME), new Date(Date.now() - hour), new Date(Date.now() - hour));
    const fresh = await upload(storage, GUEST);
    const unrelated = [path.join(rootDir, "notes"), path.join(rootDir, "guest:sweep-guest", "not-an-upload")];
    for (const dir of unrelated) await fs.mkdir(dir, { recursive: true });

    const swept = await new LocalFsStoragePurger({ rootDir }).purgeUnconfirmedUploads(new Date(Date.now() - 30 * 60 * 1000));

    expect(swept).toBe(2);
    expect(await present(oldWritten)).toBe(false);
    expect(await present(oldNeverWritten)).toBe(false);
    expect(await present(oldConfirmed)).toBe(true);
    expect(await present(fresh)).toBe(true);
    for (const dir of unrelated) expect(await present(dir)).toBe(true);
  });

  it("an upload with no record is aged by its directory", async () => {
    const storage = adapter();
    const uploadDir = await upload(storage, GUEST);
    await fs.rm(path.join(uploadDir, UPLOAD_RECORD_FILENAME));
    const old = new Date(Date.now() - 2 * UNCONFIRMED_UPLOAD_TTL_MS);
    await fs.utimes(uploadDir, old, old);

    expect(await new LocalFsStoragePurger({ rootDir }).purgeUnconfirmedUploads(new Date(Date.now() - UNCONFIRMED_UPLOAD_TTL_MS))).toBe(1);
    expect(await present(uploadDir)).toBe(false);
  });

  it("a root that does not exist yet has nothing to sweep", async () => {
    await expect(new LocalFsStoragePurger({ rootDir: path.join(rootDir, "missing") }).purgeUnconfirmedUploads(new Date())).resolves.toBe(0);
  });
});

describe("createUploadTarget — the opportunistic sweep", () => {
  const abandonedAge = UNCONFIRMED_UPLOAD_TTL_MS + UNCONFIRMED_SWEEP_INTERVAL_MS + 60_000;

  it("sweeps uploads unconfirmable for an interval, spares one only just past its confirm window, and runs at most once per interval", async () => {
    const seeding = adapter();
    const abandoned = await upload(seeding, GUEST, { ageMs: abandonedAge });
    const justExpired = await upload(seeding, GUEST, { ageMs: UNCONFIRMED_UPLOAD_TTL_MS + 60_000 });

    const storage = adapter();
    await upload(storage, OTHER);

    expect(await present(abandoned)).toBe(false);
    expect(await present(justExpired)).toBe(true);

    const abandonedLater = await upload(seeding, GUEST, { ageMs: abandonedAge });
    await upload(storage, OTHER);
    expect(await present(abandonedLater)).toBe(true);
  });

  it("a failed sweep is logged and never fails the upload", async () => {
    const seeding = adapter();
    await upload(seeding, GUEST, { ageMs: abandonedAge });
    const ownerDir = path.join(rootDir, "guest:sweep-guest");
    await fs.chmod(ownerDir, 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const storage = adapter();
    try {
      const target = await storage.createUploadTarget(OTHER, { filename: "lease.txt", mimeType: "text/plain", sizeBytes: 10 });
      expect(target.ref).toMatch(/^user:sweep-user\//);
      // Settles rather than rejects: the sweep handles its own failure.
      await expect(storage.lastSweep).resolves.toBeUndefined();
    } finally {
      await fs.chmod(ownerDir, 0o755);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unconfirmed_upload_sweep_failed"));
  });
});
