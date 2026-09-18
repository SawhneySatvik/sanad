// Runs the shared StorageAdapter contract (owner-prefix validation + cross-principal IDOR
// assertions + principal-required-on-every-method) against LocalFsStorageAdapter. Named
// `*.idor.test.ts` so `npm test -- idor` picks these up alongside the other IDOR suites.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Principal } from "@/server/core/types";
import { storageAdapterContract } from "@tests/support/contracts/storage-adapter";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { MAX_UPLOAD_SIZE_BYTES } from "@/server/storage/policy";
import { verifyLocalUrl } from "@/server/storage/signed-url";
import type { AccessCheck } from "@/server/storage/types";

const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-contract-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

storageAdapterContract((accessCheck) => {
  const adapter = new LocalFsStorageAdapter({
    accessCheck,
    rootDir: tempDir,
    signingSecret: SIGNING_SECRET,
  });
  return {
    adapter,
    completeUpload: async (target, principal: Principal, bytes: Buffer) => {
      if (target.method !== "server-relay") {
        throw new Error(`LocalFsStorageAdapter must return server-relay, got ${target.method}`);
      }
      await adapter.writeRelayed(principal, target.ref, bytes);
    },
  };
});

describe("LocalFsStorageAdapter — local-specific behavior beyond the shared contract", () => {
  it("getSignedUrl returns a URL that verifyLocalUrl actually round-trips (not just a substring match)", async () => {
    const accessCheck = vi.fn<AccessCheck>(() => true);
    const adapter = new LocalFsStorageAdapter({
      accessCheck,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const principal: Principal = { type: "user", userId: "user-a" };
    const bytes = Buffer.from("hello");
    const target = await adapter.createUploadTarget(principal, {
      filename: "lease.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });
    await adapter.writeRelayed(principal, target.ref, bytes);
    await adapter.confirmUpload(principal, target.ref);
    const beforeMs = Date.now();
    const url = await adapter.getSignedUrl(principal, {
      storageRef: target.ref,
      ownerUserId: "user-a",
      ownerGuestSessionId: null,
    });

    // A substring check (url.startsWith(...), .toContain("sig=")) can't fail against a mutant that
    // scrambles the signature or the ref it signs over, as long as the literal substrings are still
    // present. Actually verify it, the same way a future consuming route would.
    const verified = verifyLocalUrl(SIGNING_SECRET, url);
    expect(verified).not.toBeNull();
    expect(verified?.ref).toBe(target.ref);
    expect(verified?.expiresAtMs).toBeGreaterThan(beforeMs);

    // Ties authorization to the served object: the ref accessCheck was actually invoked with is the
    // SAME ref the signed URL actually serves, not merely deep-equal by coincidence.
    expect(accessCheck.mock.calls[0][1].storageRef).toBe(verified?.ref);

    // Negative controls: wrong secret, tampered ref, and expired all fail.
    expect(verifyLocalUrl("a-different-secret-at-least-32-bytes!!", url)).toBeNull();
    const tamperedRefUrl = url.replace(
      encodeURIComponent(target.ref),
      encodeURIComponent(`${target.ref}x`),
    );
    expect(verifyLocalUrl(SIGNING_SECRET, tamperedRefUrl)).toBeNull();
    expect(verifyLocalUrl(SIGNING_SECRET, url, (verified?.expiresAtMs ?? 0) + 1)).toBeNull();
  });

  it("createUploadTarget always returns method: server-relay (the acknowledged local/prod divergence, docs/ARCHITECTURE.md's Deployment view)", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const target = await adapter.createUploadTarget(
      { type: "user", userId: "user-a" },
      { filename: "lease.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    );
    expect(target.method).toBe("server-relay");
    expect(target.uploadUrl).toBeUndefined();
  });

  it("a ref is single-write: a second writeRelayed to the same ref is rejected, not silently overwritten", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const principal: Principal = { type: "user", userId: "user-a" };
    const target = await adapter.createUploadTarget(principal, {
      filename: "lease.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
    });
    await adapter.writeRelayed(principal, target.ref, Buffer.from("first"));
    await expect(
      adapter.writeRelayed(principal, target.ref, Buffer.from("second-overwrite")),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const stillFirst = await adapter.readObject(target.ref);
    expect(Buffer.from(stillFirst).toString()).toBe("first");
  });

  it("writeRelayed re-checks the ACTUAL byte count against the cap, not just the declared sizeBytes from createUploadTarget", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const principal: Principal = { type: "user", userId: "user-a" };
    // Declare a small, allowed size at target-minting time (server-relay
    // mode: this number came from the client and isn't itself trustworthy).
    const target = await adapter.createUploadTarget(principal, {
      filename: "huge.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
    });
    const actualBytes = Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1, 1);
    await expect(adapter.writeRelayed(principal, target.ref, actualBytes)).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    // Nothing was left on disk from the rejected write.
    await expect(adapter.confirmUpload(principal, target.ref)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("writeRelayed rejects bytes written under a DIFFERENT principal than the ref belongs to — creation-time check", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const guestA: Principal = { type: "guest", guestSessionId: "guest-a" };
    const guestB: Principal = { type: "guest", guestSessionId: "guest-b" };
    const target = await adapter.createUploadTarget(guestA, {
      filename: "lease.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
    });
    await expect(
      adapter.writeRelayed(guestB, target.ref, Buffer.from("attacker bytes")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The rightful owner's own confirm still correctly fails too — nothing
    // was ever written.
    await expect(adapter.confirmUpload(guestA, target.ref)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  const HOSTILE_REFS = [
    "not-a-ref-at-all",
    "user:a/b", // wrong segment count
    "admin:a/11111111-1111-1111-1111-111111111111/x.pdf", // bad key type
    "user:a/not-a-uuid/x.pdf", // bad uuid
    "user:ABC/11111111-1111-1111-1111-111111111111/x.pdf", // uppercase id — case alias
    "user:a/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/x.pdf", // uppercase uuid — case alias
    "user:a/11111111-1111-1111-1111-111111111111/..", // unsanitized filename segment
    "../../../../etc/passwd",
    "",
  ];

  it("hostile refs are rejected by readObject, confirmUpload, and delete — never a crash, never success", async () => {
    const adapter = new LocalFsStorageAdapter({
      // Deliberately permissive accessCheck — the ref itself must be what
      // fails, not the authorization step, for this test to mean anything.
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const principal: Principal = { type: "user", userId: "user-a" };
    for (const ref of HOSTILE_REFS) {
      await expect(adapter.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(adapter.confirmUpload(principal, ref)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        adapter.delete(principal, {
          storageRef: ref,
          ownerUserId: "user-a",
          ownerGuestSessionId: null,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("an upload literally named '.confirmed' can still be confirmed once, and only once — the marker filename must never collide with a real sanitized filename", async () => {
    const adapter = new LocalFsStorageAdapter({
      accessCheck: () => true,
      rootDir: tempDir,
      signingSecret: SIGNING_SECRET,
    });
    const principal: Principal = { type: "user", userId: "user-a" };
    const bytes = Buffer.from("sneaky filename");
    const target = await adapter.createUploadTarget(principal, {
      filename: ".confirmed",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });
    expect(target.ref.endsWith("/.confirmed")).toBe(true);
    await adapter.writeRelayed(principal, target.ref, bytes);
    // First confirm must succeed...
    await adapter.confirmUpload(principal, target.ref);
    // ...and a second confirm of the same ref must still fail one-shot,
    // same as any other ref — not because of a path collision with the
    // marker file itself.
    await expect(adapter.confirmUpload(principal, target.ref)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("LocalFsStorageAdapter — signing secret validation", () => {
  it("rejects a signing secret under 32 bytes at construction time", () => {
    expect(
      () =>
        new LocalFsStorageAdapter({
          accessCheck: () => true,
          rootDir: tempDir,
          signingSecret: "too-short",
        }),
    ).toThrow();
  });

  it("rejects a whitespace-only signing secret even if it's long enough", () => {
    expect(
      () =>
        new LocalFsStorageAdapter({
          accessCheck: () => true,
          rootDir: tempDir,
          signingSecret: " ".repeat(40),
        }),
    ).toThrow();
  });

  it("accepts a signing secret that is exactly 32 bytes", () => {
    expect(
      () =>
        new LocalFsStorageAdapter({
          accessCheck: () => true,
          rootDir: tempDir,
          signingSecret: "a".repeat(32),
        }),
    ).not.toThrow();
  });
});
