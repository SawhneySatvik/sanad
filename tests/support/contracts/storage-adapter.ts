// Reusable StorageAdapter contract suite. Any adapter implementation — LocalFsStorageAdapter
// today, a future Supabase adapter — must pass this unchanged. Not itself a `*.test.ts` file; a
// concrete adapter's own `*.test.ts` calls `storageAdapterContract(...)`.

import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import type {
  AccessCheck,
  CreateUploadTargetResult,
  OwnedStorageRef,
  StorageAdapter,
  StorageOwner,
} from "@/server/storage/types";

/** What a concrete adapter's own `*.test.ts` supplies to run this shared contract against it. */
export interface StorageAdapterHarness {
  adapter: StorageAdapter;
  // Completes whatever upload method createUploadTarget returned, so confirmUpload's existence
  // check can pass. Local's server-relay target is completed via adapter.writeRelayed(); a future
  // direct-put adapter's harness would PUT to `uploadUrl` — out of this shared contract's scope.
  completeUpload(
    target: CreateUploadTargetResult,
    principal: Principal,
    bytes: Buffer,
  ): Promise<void>;
}

// The contract supplies its OWN accessCheck (spied, so calls can be asserted) rather than letting
// each adapter's harness pass in whatever it likes — an independent reference implementation of
// canAccess semantics, not a test of the real thing against itself.
function referenceAccessCheck(principal: Principal, owner: StorageOwner): boolean {
  if (principal.type === "user") {
    return owner.ownerUserId === principal.userId;
  }
  return owner.ownerGuestSessionId === principal.guestSessionId;
}

/** Builds a fresh `StorageAdapterHarness` wired to the given accessCheck spy. */
export type MakeHarness = (
  accessCheck: AccessCheck,
) => Promise<StorageAdapterHarness> | StorageAdapterHarness;

// Deliberately NOT annotated `: Principal` — that widens the static type to the union and loses
// direct `.userId` access below. These literals are still structurally assignable anywhere a
// Principal is expected.
const USER_A = { type: "user", userId: "11111111-1111-1111-1111-111111111111" } as const;
const USER_B = { type: "user", userId: "22222222-2222-2222-2222-222222222222" } as const;
const GUEST_A = { type: "guest", guestSessionId: "guest-session-aaaa" } as const;
const GUEST_B = { type: "guest", guestSessionId: "guest-session-bbbb" } as const;

function ownerOf(principal: Principal): StorageOwner {
  return principal.type === "user"
    ? { ownerUserId: principal.userId, ownerGuestSessionId: null }
    : { ownerUserId: null, ownerGuestSessionId: principal.guestSessionId };
}

// Bundles a ref with an owner into the single OwnedStorageRef argument getSignedUrl/delete take —
// named separately from `ownerOf` so call sites read as "this row" rather than "this owner, and
// also this ref, which had better match".
function rowOf(ref: string, owner: StorageOwner): OwnedStorageRef {
  return { storageRef: ref, ...owner };
}

async function uploadFixture(
  makeHarness: MakeHarness,
  principal: Principal,
  bytes: Buffer,
  filename = "lease.pdf",
): Promise<{ harness: StorageAdapterHarness; accessCheck: ReturnType<typeof vi.fn>; ref: string }> {
  const accessCheck = vi.fn(referenceAccessCheck);
  const harness = await makeHarness(accessCheck);
  const target = await harness.adapter.createUploadTarget(principal, {
    filename,
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
  });
  await harness.completeUpload(target, principal, bytes);
  await harness.adapter.confirmUpload(principal, target.ref);
  return { harness, accessCheck, ref: target.ref };
}

/** Registers the shared StorageAdapter IDOR/round-trip suite; call once from each adapter's own `*.test.ts`. */
export function storageAdapterContract(makeHarness: MakeHarness): void {
  describe("StorageAdapter contract", () => {
    it("round-trips: create -> write -> confirm -> getSignedUrl for the owning principal", async () => {
      const bytes = Buffer.from("hello world");
      const { harness, ref } = await uploadFixture(makeHarness, USER_A, bytes);
      const url = await harness.adapter.getSignedUrl(USER_A, rowOf(ref, ownerOf(USER_A)));
      expect(typeof url).toBe("string");
      // Non-empty-string is deliberately NOT the whole gate here — a mutant returning a constant
      // placeholder string would still pass a bare length check. Assert it's an actual URL AND
      // that it's ref-derived (differs across two different uploads).
      expect(() => new URL(url)).not.toThrow();

      const bytes2 = Buffer.from("a different document entirely");
      const target2 = await harness.adapter.createUploadTarget(USER_A, {
        filename: "other.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes2.byteLength,
      });
      await harness.completeUpload(target2, USER_A, bytes2);
      await harness.adapter.confirmUpload(USER_A, target2.ref);
      const url2 = await harness.adapter.getSignedUrl(USER_A, rowOf(target2.ref, ownerOf(USER_A)));
      expect(url2).not.toBe(url);
    });

    it("readObject returns exactly the bytes written — server-internal, not principal-scoped", async () => {
      const bytes = Buffer.from("the quick brown fox jumps over the lazy dog");
      const { harness, ref } = await uploadFixture(makeHarness, USER_A, bytes);
      const readBack = await harness.adapter.readObject(ref);
      expect(Buffer.from(readBack).equals(bytes)).toBe(true);
    });

    it("IDOR: getSignedUrl throws NOT_FOUND for a different USER principal", async () => {
      const bytes = Buffer.from("user vs user");
      const { harness, ref } = await uploadFixture(makeHarness, USER_A, bytes);
      await expect(
        harness.adapter.getSignedUrl(USER_B, rowOf(ref, ownerOf(USER_A))),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("IDOR: getSignedUrl throws NOT_FOUND for a different GUEST principal", async () => {
      const bytes = Buffer.from("guest vs guest");
      const { harness, ref } = await uploadFixture(makeHarness, GUEST_A, bytes);
      await expect(
        harness.adapter.getSignedUrl(GUEST_B, rowOf(ref, ownerOf(GUEST_A))),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("accessCheck is invoked with the exact (principal, owner) pair on getSignedUrl", async () => {
      const bytes = Buffer.from("spy check");
      const { harness, accessCheck, ref } = await uploadFixture(makeHarness, USER_A, bytes);
      accessCheck.mockClear();
      const owner = ownerOf(USER_A);
      const row = rowOf(ref, owner);
      await harness.adapter.getSignedUrl(USER_A, row);
      // The adapter receives (and must forward to accessCheck) the FULL row, not just the owner
      // columns — nothing should silently strip `storageRef` off before forwarding it.
      expect(accessCheck).toHaveBeenCalledWith(USER_A, row);
    });

    it("ownership change: after `owner` reflects a new user, the NEW owner succeeds even though the ref still carries the old guest prefix", async () => {
      const bytes = Buffer.from("claimed document");
      const { harness, ref } = await uploadFixture(makeHarness, GUEST_A, bytes);
      expect(ref.startsWith("guest:guest-session-aaaa/")).toBe(true);
      const newOwner: StorageOwner = { ownerUserId: USER_A.userId, ownerGuestSessionId: null };
      const url = await harness.adapter.getSignedUrl(USER_A, rowOf(ref, newOwner));
      expect(url.length).toBeGreaterThan(0);
      // The ref's own text never changes — ownership moved in the DB row, not in storage.
      expect(ref.startsWith("guest:guest-session-aaaa/")).toBe(true);
    });

    it("ownership change: the OLD guest principal is denied once `owner` reflects the new user — proves access follows current owner, not a re-parsed ref prefix", async () => {
      const bytes = Buffer.from("claimed document, old principal retries");
      const { harness, ref } = await uploadFixture(makeHarness, GUEST_A, bytes);
      const newOwner: StorageOwner = { ownerUserId: USER_A.userId, ownerGuestSessionId: null };
      // GUEST_A's key still matches the ref's prefix, but the DB row's
      // current owner (newOwner) no longer says GUEST_A — a ref-prefix-based
      // check would wrongly allow this; the accessCheck-based one must not.
      await expect(
        harness.adapter.getSignedUrl(GUEST_A, rowOf(ref, newOwner)),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("ownership change: delete authorizes against the NEW owner too, not just getSignedUrl", async () => {
      const bytes = Buffer.from("claimed document, deleted by new owner");
      const { harness, ref } = await uploadFixture(makeHarness, GUEST_A, bytes);
      const newOwner: StorageOwner = { ownerUserId: USER_A.userId, ownerGuestSessionId: null };
      await harness.adapter.delete(USER_A, rowOf(ref, newOwner));
      await expect(harness.adapter.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("ownership change: the OLD guest principal is denied delete once `owner` reflects the new user — object survives (positive control)", async () => {
      const bytes = Buffer.from("claimed document, old principal tries to delete");
      const { harness, ref } = await uploadFixture(makeHarness, GUEST_A, bytes);
      const newOwner: StorageOwner = { ownerUserId: USER_A.userId, ownerGuestSessionId: null };
      await expect(harness.adapter.delete(GUEST_A, rowOf(ref, newOwner))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const stillThere = await harness.adapter.readObject(ref);
      expect(Buffer.from(stillThere).equals(bytes)).toBe(true);
    });

    it("accessCheck is invoked with the exact (principal, owner) pair on delete", async () => {
      const bytes = Buffer.from("spy check delete");
      const { harness, accessCheck, ref } = await uploadFixture(makeHarness, USER_A, bytes);
      accessCheck.mockClear();
      const owner = ownerOf(USER_A);
      const row = rowOf(ref, owner);
      await harness.adapter.delete(USER_A, row);
      expect(accessCheck).toHaveBeenCalledWith(USER_A, row);
    });

    it("confirmUpload rejects a caller whose principalKey is a STRING PREFIX of the ref's principalKey (or vice versa) — guards against a startsWith-based mutant", async () => {
      const accessCheck = vi.fn(referenceAccessCheck);
      const harness = await makeHarness(accessCheck);
      const bytes = Buffer.from("prefix confusion a");
      const shortGuest: Principal = { type: "guest", guestSessionId: "abc" };
      const longGuest: Principal = { type: "guest", guestSessionId: "abcdef" };

      const targetShort = await harness.adapter.createUploadTarget(shortGuest, {
        filename: "lease.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
      });
      await harness.completeUpload(targetShort, shortGuest, bytes);
      // "guest:abcdef".startsWith("guest:abc") is true — a buggy
      // startsWith/prefix check would wrongly accept this.
      await expect(
        harness.adapter.confirmUpload(longGuest, targetShort.ref),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const targetLong = await harness.adapter.createUploadTarget(longGuest, {
        filename: "lease.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
      });
      await harness.completeUpload(targetLong, longGuest, bytes);
      // The reverse: "guest:abc" is a PREFIX of "guest:abcdef", not equal
      // to it — must still be rejected.
      await expect(
        harness.adapter.confirmUpload(shortGuest, targetLong.ref),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("confirmUpload rejects a caller of a DIFFERENT principal TYPE sharing the SAME id string — guards against a type-blind mutant", async () => {
      const accessCheck = vi.fn(referenceAccessCheck);
      const harness = await makeHarness(accessCheck);
      const sharedId = "22222222-2222-2222-2222-222222222222";
      const asGuest: Principal = { type: "guest", guestSessionId: sharedId };
      const asUser: Principal = { type: "user", userId: sharedId };
      const bytes = Buffer.from("type confusion");

      const target = await harness.adapter.createUploadTarget(asGuest, {
        filename: "lease.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
      });
      await harness.completeUpload(target, asGuest, bytes);
      // "guest:<id>" !== "user:<id>" even though the raw id matches.
      await expect(harness.adapter.confirmUpload(asUser, target.ref)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("confirmUpload rejects a ref minted for another principal", async () => {
      const accessCheck = vi.fn(referenceAccessCheck);
      const harness = await makeHarness(accessCheck);
      const bytes = Buffer.from("mismatched owner");
      const target = await harness.adapter.createUploadTarget(USER_A, {
        filename: "lease.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
      });
      await harness.completeUpload(target, USER_A, bytes);
      await expect(harness.adapter.confirmUpload(USER_B, target.ref)).rejects.toBeInstanceOf(
        AppError,
      );
      await expect(harness.adapter.confirmUpload(USER_B, target.ref)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("confirmUpload is one-shot: a second confirm of the same ref fails, even by the legitimate owner", async () => {
      const accessCheck = vi.fn(referenceAccessCheck);
      const harness = await makeHarness(accessCheck);
      const bytes = Buffer.from("confirm me once");
      const target = await harness.adapter.createUploadTarget(USER_A, {
        filename: "lease.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.byteLength,
      });
      await harness.completeUpload(target, USER_A, bytes);
      await harness.adapter.confirmUpload(USER_A, target.ref);
      await expect(harness.adapter.confirmUpload(USER_A, target.ref)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("confirmUpload fails when nothing was written to the ref", async () => {
      const accessCheck = vi.fn(referenceAccessCheck);
      const harness = await makeHarness(accessCheck);
      const target = await harness.adapter.createUploadTarget(USER_A, {
        filename: "never-written.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      });
      await expect(harness.adapter.confirmUpload(USER_A, target.ref)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("IDOR: delete throws NOT_FOUND for a non-owning principal, and the object is still readable afterward (positive control)", async () => {
      const bytes = Buffer.from("do not delete me");
      const { harness, ref } = await uploadFixture(makeHarness, USER_A, bytes);
      await expect(
        harness.adapter.delete(USER_B, rowOf(ref, ownerOf(USER_A))),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const stillThere = await harness.adapter.readObject(ref);
      expect(Buffer.from(stillThere).equals(bytes)).toBe(true);
    });

    it("delete succeeds for the owning principal and the object is gone afterward", async () => {
      const bytes = Buffer.from("delete me");
      const { harness, ref } = await uploadFixture(makeHarness, USER_A, bytes);
      await harness.adapter.delete(USER_A, rowOf(ref, ownerOf(USER_A)));
      await expect(harness.adapter.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("createUploadTarget rejects a disallowed mimeType with INVALID_DOCUMENT", async () => {
      const accessCheck = vi.fn(referenceAccessCheck);
      const harness = await makeHarness(accessCheck);
      await expect(
        harness.adapter.createUploadTarget(USER_A, {
          filename: "malware.exe",
          mimeType: "application/x-msdownload",
          sizeBytes: 10,
        }),
      ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    });

    it("createUploadTarget rejects an oversized declared size with INVALID_DOCUMENT", async () => {
      const accessCheck = vi.fn(referenceAccessCheck);
      const harness = await makeHarness(accessCheck);
      await expect(
        harness.adapter.createUploadTarget(USER_A, {
          filename: "huge.pdf",
          mimeType: "application/pdf",
          sizeBytes: 500 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    });
  });
}
