import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@/server/core/types";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { displayFilename, MAX_DISPLAY_FILENAME_CHARS, UNCONFIRMED_UPLOAD_TTL_MS } from "@/server/storage/policy";
import { CONFIRMED_MARKER_FILENAME, UPLOAD_RECORD_FILENAME } from "@/server/storage/upload-records";

// confirmUpload returns what createUploadTarget was told — the declared type and a display-safe
// filename — so a document never takes either from the later request that confirms the upload.

const GUEST: Principal = { type: "guest", guestSessionId: "record-guest" };
const cp = (...points: number[]) => String.fromCodePoint(...points);

let rootDir: string;
let adapter: LocalFsStorageAdapter;
beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "upload-record-"));
  adapter = new LocalFsStorageAdapter({ rootDir, accessCheck: () => true, signingSecret: "upload-record-signing-secret-0123456789" });
});
afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function uploaded(filename: string, mimeType = "text/plain") {
  const bytes = Buffer.from("the bytes");
  const target = await adapter.createUploadTarget(GUEST, { filename, mimeType, sizeBytes: bytes.byteLength });
  await adapter.writeRelayed(GUEST, target.ref, bytes);
  return { ref: target.ref, uploadDir: path.join(rootDir, ...target.ref.split("/").slice(0, 2)) };
}

describe("LocalFsStorageAdapter — the upload record", () => {
  it("confirmUpload returns the declared filename and type", async () => {
    const { ref } = await uploaded("Lease 2026 (final).pdf", "application/pdf");

    await expect(adapter.confirmUpload(GUEST, ref)).resolves.toEqual({ filename: "Lease 2026 (final).pdf", mimeType: "application/pdf" });
  });

  it("the stored filename has no control or bidi characters", async () => {
    const rlo = cp(0x202e);
    const hostile = `lease${rlo}fdp.exe${cp(0x0000, 0x001b, 0x007f, 0x0085, 0x2066, 0x200f, 0x061c)}.txt`;
    const { ref } = await uploaded(hostile);

    const { filename } = await adapter.confirmUpload(GUEST, ref);

    expect(filename).toBe("leasefdp.exe.txt");
    expect(filename).not.toMatch(/\p{Cc}/u);
  });

  it("displayFilename keeps whole code points under the cap, replaces lone surrogates, and never returns blank", () => {
    const emoji = cp(0x1f4c4);
    const long = emoji.repeat(MAX_DISPLAY_FILENAME_CHARS + 50);

    expect(Array.from(displayFilename(long))).toHaveLength(MAX_DISPLAY_FILENAME_CHARS);
    expect(displayFilename(long).isWellFormed()).toBe(true);
    const loneSurrogate = `a${String.fromCharCode(0xd800)}b`;
    expect(loneSurrogate.isWellFormed()).toBe(false);
    expect(displayFilename(loneSurrogate).isWellFormed()).toBe(true);
    expect(displayFilename(`${cp(0x202e, 0x0009)}  `)).toBe("document");
  });

  it("an upload older than the confirm window is NOT_FOUND and never marked confirmed", async () => {
    const { ref, uploadDir } = await uploaded("lease.txt");
    const past = new Date(Date.now() - UNCONFIRMED_UPLOAD_TTL_MS - 60_000);
    await fs.utimes(path.join(uploadDir, UPLOAD_RECORD_FILENAME), past, past);

    await expect(adapter.confirmUpload(GUEST, ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fs.stat(path.join(uploadDir, CONFIRMED_MARKER_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an upload with no record — written before records existed — is NOT_FOUND: its type can't be bound", async () => {
    const { ref, uploadDir } = await uploaded("lease.txt");
    await fs.rm(path.join(uploadDir, UPLOAD_RECORD_FILENAME));

    await expect(adapter.confirmUpload(GUEST, ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("delete removes the record along with the object and marker", async () => {
    const { ref, uploadDir } = await uploaded("lease.txt");
    await adapter.confirmUpload(GUEST, ref);

    await adapter.delete(GUEST, { storageRef: ref, ownerUserId: null, ownerGuestSessionId: "record-guest" });

    expect(await fs.readdir(uploadDir)).toEqual([]);
  });
});
