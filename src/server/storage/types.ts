/**
 * The StorageAdapter interface. Any implementation must answer a non-owner with NOT_FOUND on
 * getSignedUrl and delete, authorizing against the row's current owner (never the ref's prefix);
 * accept confirmUpload once, only from the principal the ref was minted for, after its bytes exist,
 * returning what the target was declared as; and reject a disallowed type or size in
 * createUploadTarget with INVALID_DOCUMENT.
 */

import type { Principal } from "../core/types";

/**
 * The resource row's current ownership columns, passed in fresh by the caller on every
 * getSignedUrl/delete call — the adapter never re-derives ownership from the ref's prefix. After a
 * guest-to-user claim, the ref keeps its `guest:<sessionId>` prefix forever; the DB row's owner
 * columns are what change, and access must follow those.
 */
export interface StorageOwner {
  ownerUserId: string | null;
  ownerGuestSessionId: string | null;
}

/**
 * The owning DB row's ref plus its current ownership, bundled as one argument so the ref that gets
 * authorized is the ref that gets served — a caller sourcing `row` from one repository read can't
 * mismatch a ref from one row with an owner from another.
 */
export interface OwnedStorageRef extends StorageOwner {
  storageRef: string;
}

/**
 * Injected by the composition root, which passes the real `canAccess` (src/server/data/access.ts).
 * Typed on OwnedStorageRef, not the narrower StorageOwner: stripping `storageRef` before calling
 * `this.accessCheck(...)` now fails `tsc`, not just a runtime spy assertion.
 */
export type AccessCheck = (principal: Principal, row: OwnedStorageRef) => boolean;

/**
 * Compile-time proof that AccessCheck above still accepts a canAccess-shaped function. If this stops
 * compiling, AccessCheck has drifted from what canAccess can actually satisfy.
 */
export const _assertAccessCheckAcceptsOwnerShapedFunction: AccessCheck = (
  principal: Principal,
  resource: StorageOwner,
) => {
  void principal;
  void resource;
  return false;
};

/** Metadata a caller supplies to mint an upload target. */
export interface CreateUploadTargetInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * What an upload was declared as when its target was created — the filename cleaned for display
 * (policy.ts's displayFilename) — returned by confirmUpload so a document takes these, never what a
 * later request claims.
 */
export interface ConfirmedUpload {
  filename: string;
  mimeType: string;
}

/** Where and how the client should upload: a direct signed-URL PUT, or bytes relayed through the server. */
export interface CreateUploadTargetResult {
  method: "direct-put" | "server-relay";
  uploadUrl?: string;
  ref: string;
}

/** The request-scoped storage interface routes and services use; every method but `readObject` takes a `Principal` first. */
export interface StorageAdapter {
  // Mints a ref without the object existing server-side yet. Validates mimeType/sizeBytes against
  // policy.ts's allowlist/cap — throws AppError("INVALID_DOCUMENT") before any bytes move anywhere.
  createUploadTarget(
    principal: Principal,
    metadata: CreateUploadTargetInput,
  ): Promise<CreateUploadTargetResult>;

  // The server-relay write step. Only called when createUploadTarget returned `method:
  // "server-relay"`; a direct-put/prod adapter's bytes never pass through the server, so that adapter
  // can throw here — the route handler branches on `method` and never calls this for a direct-put target.
  writeRelayed(principal: Principal, ref: string, bytes: Uint8Array): Promise<void>;

  // Verifies the object exists and that `ref`'s owner-prefix matches the calling principal. This is
  // the one place the ref's prefix is itself an authorization input — every later access authorizes
  // against the DB row's current owner instead (see StorageOwner). `ref` here is client-supplied.
  // Returns what createUploadTarget was told; an upload not confirmed within
  // UNCONFIRMED_UPLOAD_TTL_MS (policy.ts) of its target's creation is NOT_FOUND.
  confirmUpload(principal: Principal, ref: string): Promise<ConfirmedUpload>;

  // Server-internal only — deliberately not principal-scoped. Callers (services) must authorize
  // against the DB row's current owner themselves, via canAccess, before calling this — never from a
  // route handler directly.
  readObject(ref: string): Promise<Buffer>;

  // `row` bundles the ref with the DB row's current owner — see OwnedStorageRef. Authorizes via the
  // injected AccessCheck against `row`'s owner columns, never by re-parsing `row.storageRef`'s prefix.
  getSignedUrl(principal: Principal, row: OwnedStorageRef): Promise<string>;

  delete(principal: Principal, row: OwnedStorageRef): Promise<void>;
}

/**
 * System-only interface for the TTL sweep — deliberately has no `Principal` anywhere in its surface,
 * since that job decides eligible refs by querying expired rows itself, then just deletes bytes, not
 * an authorization decision. Never hand this to a route or service — construct it as a wholly
 * separate object, so nothing holding a `StorageAdapter` reference can reach it by accident.
 */
export interface StoragePurger {
  purge(refs: string[]): Promise<void>;
  // Deletes every upload never confirmed whose target was created before `createdBefore`; no row
  // references those, so the TTL sweep's expired-row query never finds them. Returns how many.
  purgeUnconfirmedUploads(createdBefore: Date): Promise<number>;
}

/**
 * Compile-time enforcement that every StorageAdapter method except `readObject` takes a Principal as
 * its first parameter — an edit that made one optional or dropped it fails `tsc` here. Not `F extends
 * (first: Principal, ...) => unknown`, which an optional first parameter also satisfies; requiring the
 * first tuple element be exactly `Principal` is what catches an optional/dropped/reordered parameter.
 */
type RequiresPrincipalFirst<F extends (...args: never[]) => unknown> =
  Parameters<F> extends [infer P, ...unknown[]]
    ? [P] extends [Principal]
      ? [Principal] extends [P]
        ? true
        : false
      : false
    : false;
/** Satisfies RequiresPrincipalFirst for every StorageAdapter method except `readObject`. */
export const PRINCIPAL_REQUIRED_ON_EVERY_METHOD_EXCEPT_readObject: {
  createUploadTarget: RequiresPrincipalFirst<StorageAdapter["createUploadTarget"]>;
  writeRelayed: RequiresPrincipalFirst<StorageAdapter["writeRelayed"]>;
  confirmUpload: RequiresPrincipalFirst<StorageAdapter["confirmUpload"]>;
  getSignedUrl: RequiresPrincipalFirst<StorageAdapter["getSignedUrl"]>;
  delete: RequiresPrincipalFirst<StorageAdapter["delete"]>;
} = {
  createUploadTarget: true,
  writeRelayed: true,
  confirmUpload: true,
  getSignedUrl: true,
  delete: true,
};

/**
 * Compile-time enforcement that `StorageAdapter` never grows a `purge` member — `StoragePurger.purge`
 * stays reachable only through the wholly separate object it lives on (see StoragePurger above). If a
 * future edit adds `purge` to `StorageAdapter`, this becomes `false`, failing to satisfy `true` below.
 */
type StorageAdapterNeverExposesPurge = "purge" extends keyof StorageAdapter ? false : true;
/** Always `true`; a compile error at its declaration means StorageAdapter gained a `purge` member. */
export const STORAGE_ADAPTER_NEVER_EXPOSES_PURGE: StorageAdapterNeverExposesPurge = true;
