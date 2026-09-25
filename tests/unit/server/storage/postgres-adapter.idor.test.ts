// Runs the shared StorageAdapter contract (owner-prefix validation + cross-principal IDOR
// assertions + principal-required-on-every-method) against PostgresStorageAdapter, over a real
// PGlite database (migrated schema, storage_objects included). Named `*.idor.test.ts` so `npm test
// -- idor` picks these up alongside the other IDOR suites.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/server/core/types";
import { storageAdapterContract } from "@tests/support/contracts/storage-adapter";
import {
  POSTGRES_MAX_UPLOAD_BYTES,
  PostgresStorageAdapter,
} from "@/server/storage/postgres-adapter";
import { PostgresStoragePurger } from "@/server/storage/postgres-purger";
import { UNCONFIRMED_UPLOAD_TTL_MS } from "@/server/storage/policy";
import { buildRef } from "@/server/storage/refs";
import { verifyLocalUrl } from "@/server/storage/signed-url";
import type { AccessCheck } from "@/server/storage/types";
import { createTestDb, type TestDb } from "@tests/support/db";

const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

storageAdapterContract((accessCheck) => {
  const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck, signingSecret: SIGNING_SECRET });
  return {
    adapter,
    completeUpload: async (target, principal: Principal, bytes: Buffer) => {
      if (target.method !== "server-relay") {
        throw new Error(`PostgresStorageAdapter must return server-relay, got ${target.method}`);
      }
      await adapter.writeRelayed(principal, target.ref, bytes);
    },
  };
});

describe("PostgresStorageAdapter — Postgres-specific behavior beyond the shared contract", () => {
  it("getSignedUrl returns a URL that verifyLocalUrl actually round-trips (not just a substring match)", async () => {
    const accessCheck = vi.fn<AccessCheck>(() => true);
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck, signingSecret: SIGNING_SECRET });
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

    const verified = verifyLocalUrl(SIGNING_SECRET, url);
    expect(verified).not.toBeNull();
    expect(verified?.ref).toBe(target.ref);
    expect(verified?.expiresAtMs).toBeGreaterThan(beforeMs);
    expect(accessCheck.mock.calls[0][1].storageRef).toBe(verified?.ref);

    expect(verifyLocalUrl("a-different-secret-at-least-32-bytes!!", url)).toBeNull();
    const tamperedRefUrl = url.replace(encodeURIComponent(target.ref), encodeURIComponent(`${target.ref}x`));
    expect(verifyLocalUrl(SIGNING_SECRET, tamperedRefUrl)).toBeNull();
    expect(verifyLocalUrl(SIGNING_SECRET, url, (verified?.expiresAtMs ?? 0) + 1)).toBeNull();
  });

  it("createUploadTarget always returns method: server-relay — the relay is what enforces MAX_RELAY_UPLOAD_BYTES before this adapter ever sees the bytes", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const target = await adapter.createUploadTarget(
      { type: "user", userId: "user-a" },
      { filename: "lease.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    );
    expect(target.method).toBe("server-relay");
    expect(target.uploadUrl).toBeUndefined();
  });

  it("createUploadTarget rejects a declared size over the Postgres cap even though it is under MAX_UPLOAD_SIZE_BYTES", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    await expect(
      adapter.createUploadTarget(
        { type: "user", userId: "user-a" },
        { filename: "big.pdf", mimeType: "application/pdf", sizeBytes: POSTGRES_MAX_UPLOAD_BYTES + 1 },
      ),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });
  });

  it("a ref is single-write: a second writeRelayed to the same ref is rejected, not silently overwritten", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const principal: Principal = { type: "user", userId: "user-a" };
    const target = await adapter.createUploadTarget(principal, {
      filename: "lease.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
    });
    await adapter.writeRelayed(principal, target.ref, Buffer.from("first"));
    await expect(adapter.writeRelayed(principal, target.ref, Buffer.from("second-overwrite"))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const stillFirst = await adapter.readObject(target.ref);
    expect(Buffer.from(stillFirst).toString()).toBe("first");
  });

  it("writeRelayed re-checks the ACTUAL byte count against the Postgres cap, not just the declared sizeBytes from createUploadTarget", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const principal: Principal = { type: "user", userId: "user-a" };
    // Declare a small, allowed size at target-minting time (server-relay mode: this number came
    // from the client and isn't itself trustworthy).
    const target = await adapter.createUploadTarget(principal, {
      filename: "huge.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
    });
    const actualBytes = Buffer.alloc(POSTGRES_MAX_UPLOAD_BYTES + 1, 1);
    await expect(adapter.writeRelayed(principal, target.ref, actualBytes)).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "too_large",
    });
    // Nothing was left on the row from the rejected write.
    await expect(adapter.confirmUpload(principal, target.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("writeRelayed rejects bytes written under a DIFFERENT principal than the ref belongs to — creation-time check", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const guestA: Principal = { type: "guest", guestSessionId: "guest-a" };
    const guestB: Principal = { type: "guest", guestSessionId: "guest-b" };
    const target = await adapter.createUploadTarget(guestA, {
      filename: "lease.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
    });
    await expect(adapter.writeRelayed(guestB, target.ref, Buffer.from("attacker bytes"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // The rightful owner's own confirm still correctly fails too — nothing was ever written.
    await expect(adapter.confirmUpload(guestA, target.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // samples/open.ts mints a ref with buildRef and calls writeRelayed directly, never
  // createUploadTarget — this must keep working on the Postgres adapter exactly as it does on
  // LocalFsStorageAdapter (whose writeRelayed also needs no pre-existing file).
  it("writeRelayed originates its own row for a ref createUploadTarget never minted (the samples-open path)", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const principal: Principal = { type: "guest", guestSessionId: "guest-sample" };
    const ref = buildRef(principal, "lease.pdf");
    const bytes = Buffer.from("recorded sample text");

    await adapter.writeRelayed(principal, ref, bytes);

    const readBack = await adapter.readObject(ref);
    expect(Buffer.from(readBack).equals(bytes)).toBe(true);
    // Never confirmable: it carries no declared filename/mimeType, since createUploadTarget never
    // ran — matching LocalFsStorageAdapter, where confirmUpload fails without an upload-record file.
    await expect(adapter.confirmUpload(principal, ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Still deletable by its owner, same as any other object (samples/open.ts's cleanup-on-race path).
    await adapter.delete(principal, { storageRef: ref, ownerUserId: null, ownerGuestSessionId: "guest-sample" });
    await expect(adapter.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("confirmUpload rejects an upload past UNCONFIRMED_UPLOAD_TTL_MS, even with bytes present and unconfirmed", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const principal: Principal = { type: "user", userId: "user-a" };
    const target = await adapter.createUploadTarget(principal, {
      filename: "lease.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
    });
    await adapter.writeRelayed(principal, target.ref, Buffer.from("hello"));
    // Backdate created_at past the TTL, exactly as if the target had been minted long ago — the
    // adapter has no injectable clock, so this is the one way to exercise the TTL branch directly.
    await t.client.query("UPDATE storage_objects SET created_at = $1 WHERE storage_ref = $2", [
      new Date(Date.now() - UNCONFIRMED_UPLOAD_TTL_MS - 1_000).toISOString(),
      target.ref,
    ]);
    await expect(adapter.confirmUpload(principal, target.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
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
    const adapter = new PostgresStorageAdapter({
      // Deliberately permissive accessCheck — the ref itself must be what fails, not the
      // authorization step, for this test to mean anything.
      accessCheck: () => true,
      db: t.db,
      signingSecret: SIGNING_SECRET,
    });
    const principal: Principal = { type: "user", userId: "user-a" };
    for (const ref of HOSTILE_REFS) {
      await expect(adapter.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(adapter.confirmUpload(principal, ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        adapter.delete(principal, { storageRef: ref, ownerUserId: "user-a", ownerGuestSessionId: null }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("PostgresStorageAdapter — signing secret validation", () => {
  it("rejects a signing secret under 32 bytes at construction time", () => {
    expect(() => new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: "too-short" })).toThrow();
  });

  it("rejects a whitespace-only signing secret even if it's long enough", () => {
    expect(() => new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: " ".repeat(40) })).toThrow();
  });

  it("accepts a signing secret that is exactly 32 bytes", () => {
    expect(() => new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: "a".repeat(32) })).not.toThrow();
  });
});

describe("PostgresStoragePurger", () => {
  it("purge deletes rows by ref, and a ref with no matching row is a no-op", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const principal: Principal = { type: "user", userId: "user-a" };
    const keep = await adapter.createUploadTarget(principal, { filename: "keep.pdf", mimeType: "application/pdf", sizeBytes: 5 });
    const gone = await adapter.createUploadTarget(principal, { filename: "gone.pdf", mimeType: "application/pdf", sizeBytes: 5 });
    await adapter.writeRelayed(principal, keep.ref, Buffer.from("keep"));
    await adapter.writeRelayed(principal, gone.ref, Buffer.from("gone"));

    const purger = new PostgresStoragePurger({ db: t.db });
    await purger.purge([gone.ref, "user:nobody/11111111-1111-1111-1111-111111111111/never-existed.pdf"]);

    await expect(adapter.readObject(gone.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stillThere = await adapter.readObject(keep.ref);
    expect(Buffer.from(stillThere).toString()).toBe("keep");
  });

  it("purge([]) touches nothing", async () => {
    const purger = new PostgresStoragePurger({ db: t.db });
    await expect(purger.purge([])).resolves.toBeUndefined();
  });

  it("purgeUnconfirmedUploads deletes only unconfirmed rows older than createdBefore — keeps confirmed and recent ones", async () => {
    const adapter = new PostgresStorageAdapter({ db: t.db, accessCheck: () => true, signingSecret: SIGNING_SECRET });
    const principal: Principal = { type: "user", userId: "user-a" };

    const stale = await adapter.createUploadTarget(principal, { filename: "stale.pdf", mimeType: "application/pdf", sizeBytes: 5 });
    await adapter.writeRelayed(principal, stale.ref, Buffer.from("stale"));
    await t.client.query("UPDATE storage_objects SET created_at = $1 WHERE storage_ref = $2", [
      new Date(Date.now() - 3_600_000).toISOString(),
      stale.ref,
    ]);

    const confirmedOld = await adapter.createUploadTarget(principal, { filename: "old-ok.pdf", mimeType: "application/pdf", sizeBytes: 5 });
    await adapter.writeRelayed(principal, confirmedOld.ref, Buffer.from("old-ok"));
    await adapter.confirmUpload(principal, confirmedOld.ref);
    await t.client.query("UPDATE storage_objects SET created_at = $1 WHERE storage_ref = $2", [
      new Date(Date.now() - 3_600_000).toISOString(),
      confirmedOld.ref,
    ]);

    const fresh = await adapter.createUploadTarget(principal, { filename: "fresh.pdf", mimeType: "application/pdf", sizeBytes: 5 });
    await adapter.writeRelayed(principal, fresh.ref, Buffer.from("fresh"));

    const purger = new PostgresStoragePurger({ db: t.db });
    const deletedCount = await purger.purgeUnconfirmedUploads(new Date(Date.now() - 60_000));
    expect(deletedCount).toBe(1);

    await expect(adapter.readObject(stale.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(Buffer.from(await adapter.readObject(confirmedOld.ref)).toString()).toBe("old-ok");
    expect(Buffer.from(await adapter.readObject(fresh.ref)).toString()).toBe("fresh");
  });
});
