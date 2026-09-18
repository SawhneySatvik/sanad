// Exercises LocalFsStoragePurger directly: the system-only purge interface has no
// Principal/accessCheck surface, so it isn't a fit for storageAdapterContract.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Principal } from "@/server/core/types";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { LocalFsStoragePurger } from "@/server/storage/purger";

const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long";
const USER: Principal = { type: "user", userId: "user-a" };

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-purger-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("LocalFsStoragePurger", () => {
  it("removes both the object and its confirm marker", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const bytes = Buffer.from("purge me");
    const target = await adapter.createUploadTarget(USER, {
      filename: "lease.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });
    await adapter.writeRelayed(USER, target.ref, bytes);
    await adapter.confirmUpload(USER, target.ref);

    const purger = new LocalFsStoragePurger({ rootDir: tempDir });
    await purger.purge([target.ref]);

    // Direct filesystem assertion (not just adapter-method behavior, which
    // would pass even if only the object — not the marker/uuid dir — were
    // removed, since readObject/confirmUpload both fail on a missing
    // OBJECT regardless of marker state): the whole uuid directory must be
    // gone, object AND marker together.
    const [principalKeySeg, uuidSeg] = target.ref.split("/");
    await expect(
      fs.stat(path.join(tempDir, principalKeySeg, uuidSeg)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(adapter.readObject(target.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adapter.confirmUpload(USER, target.ref)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("purging one ref does not touch a sibling upload in a different uuid directory", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const bytesA = Buffer.from("purge me");
    const bytesB = Buffer.from("keep me");
    const targetA = await adapter.createUploadTarget(USER, {
      filename: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytesA.byteLength,
    });
    const targetB = await adapter.createUploadTarget(USER, {
      filename: "b.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytesB.byteLength,
    });
    await adapter.writeRelayed(USER, targetA.ref, bytesA);
    await adapter.writeRelayed(USER, targetB.ref, bytesB);
    await adapter.confirmUpload(USER, targetA.ref);
    await adapter.confirmUpload(USER, targetB.ref);

    const purger = new LocalFsStoragePurger({ rootDir: tempDir });
    await purger.purge([targetA.ref]);

    await expect(adapter.readObject(targetA.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stillThere = await adapter.readObject(targetB.ref);
    expect(Buffer.from(stillThere).equals(bytesB)).toBe(true);
  });

  it("throws on a malformed ref rather than silently skipping it", async () => {
    const purger = new LocalFsStoragePurger({ rootDir: tempDir });
    await expect(purger.purge(["not-a-valid-ref"])).rejects.toThrow();
  });
});
