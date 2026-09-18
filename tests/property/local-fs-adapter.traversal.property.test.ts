// Property test: no filename, however hostile, can make LocalFsStorageAdapter write anywhere
// other than exactly root/<principalKey>/<uuid>/<filename>. The filename-segment SHAPE assertion
// and the "uuid dir's only entry is this filename" check below are the main evidence.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import type { Principal } from "@/server/core/types";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { UPLOAD_RECORD_FILENAME } from "@/server/storage/upload-records";

const USER: Principal = { type: "user", userId: "user-a" };

let sentinelDir: string;
let rootDir: string;

beforeEach(async () => {
  sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-sentinel-"));
  rootDir = path.join(sentinelDir, "root");
  await fs.mkdir(rootDir);
});

afterEach(async () => {
  await fs.rm(sentinelDir, { recursive: true, force: true });
});

const hostileFragment = fc.constantFrom(
  "..",
  ".",
  "/",
  "\\",
  "\0",
  "C:",
  "~",
  "  ",
  "%2e%2e",
  "....//....//etc/passwd",
  "..\\..\\windows\\system32\\evil.dll",
  "/etc/passwd",
  "a/b/../../c",
  "😀",
  "\t\n",
  "user:forged",
);
const hostileFilename = fc
  .array(hostileFragment, { minLength: 1, maxLength: 6 })
  .map((parts) => parts.join(""));
const filenameArb = fc.oneof(hostileFilename, fc.string({ minLength: 0, maxLength: 40 }));

describe("LocalFsStorageAdapter — path-traversal property (fast-check)", () => {
  it("every generated filename resolves to a path inside the storage root and round-trips correctly", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir,
      signingSecret: "test-signing-secret-at-least-32-bytes-long",
    });
    const bytes = Buffer.from("payload");

    await fc.assert(
      fc.asyncProperty(filenameArb, async (filename) => {
        const target = await adapter.createUploadTarget(USER, {
          filename,
          mimeType: "application/pdf",
          sizeBytes: bytes.byteLength,
        });
        const segments = target.ref.split("/");
        expect(segments).toHaveLength(3);
        // Literal placement, not a re-derivation: comparing against a re-resolved `path.resolve`
        // would be tautological (it'd agree with wherever the file landed, sanitized or not).
        // Assert the sanitized SHAPE of the filename segment — what a disabled sanitizer violates.
        const filenameSegment = segments[2];
        expect(filenameSegment).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
        expect(filenameSegment).not.toMatch(/^\.+$/);

        await adapter.writeRelayed(USER, target.ref, bytes);

        // The object must land at EXACTLY root/<principalKey>/<uuid>/<filename> — require the
        // filename segment to be the uuid directory's only entry besides the upload record
        // createUploadTarget wrote, not "some file somewhere under root" (which a traversal could
        // still satisfy after resolving back inward).
        const uuidDir = path.join(rootDir, segments[0], segments[1]);
        const entries = await fs.readdir(uuidDir);
        expect(entries.sort()).toEqual([UPLOAD_RECORD_FILENAME, filenameSegment].sort());

        const readBack = await adapter.readObject(target.ref);
        expect(Buffer.from(readBack).equals(bytes)).toBe(true);
      }),
      { numRuns: 300 },
    );

    // Secondary check: nothing escaped upward next to the storage root during any iteration. A
    // single hostile segment can climb at most one directory level given this ref shape, so this
    // is not expected to be what actually catches a breach — the assertions above are.
    const sentinelEntries = await fs.readdir(sentinelDir);
    expect(sentinelEntries).toEqual(["root"]);
  });
});
