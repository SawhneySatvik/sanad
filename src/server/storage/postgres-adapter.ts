/**
 * Postgres-backed (bytea) StorageAdapter — the durable sibling to local-fs-adapter.ts, for
 * deployments with no shared/persistent disk (Vercel: each function instance has its own ephemeral
 * filesystem). Every round trip lands in src/db/schema.ts's storage_objects table instead, so any
 * instance can serve any step of an upload. See ./types.ts for the interface contract; this mirrors
 * local-fs-adapter.ts method-for-method, substituting a row for a file.
 */

import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { storageObjects } from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import {
  assertSizeWithinCap,
  assertUploadAllowed,
  assertWrittenSizeAllowed,
  displayFilename,
  UNCONFIRMED_UPLOAD_TTL_MS,
} from "./policy";
import { sweepUnconfirmedUploads } from "./postgres-purger";
import { buildRef, parseRef, principalKey, refBelongsTo } from "./refs";
import { assertUsableSigningSecret, signLocalUrl } from "./signed-url";
import type {
  AccessCheck,
  ConfirmedUpload,
  CreateUploadTargetInput,
  CreateUploadTargetResult,
  OwnedStorageRef,
  StorageAdapter,
} from "./types";

// Matches LocalFsStorageAdapter's own local-only TTL — arbitrary, not a security boundary (the
// signature itself is what a caller can't forge).
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/** Matches LocalFsStorageAdapter's own opportunistic-sweep cadence (local-fs-adapter.ts). */
const UNCONFIRMED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Vercel's function request body limit is ~4.5 MB, and this adapter's uploads are relayed through
 * the server (writeRelayed) rather than a direct-to-store PUT — so a file under MAX_UPLOAD_SIZE_BYTES
 * (15 MB) but over this narrower cap must still fail here, with the same INVALID_DOCUMENT/too_large
 * shape, instead of the relay request failing at the platform layer with no error card at all. Checked
 * against BOTH the declared size (createUploadTarget) and the actual relayed bytes (writeRelayed) —
 * the declared size is client-supplied and isn't itself trustworthy (policy.ts's own comment on
 * assertWrittenSizeAllowed).
 */
export const POSTGRES_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Constructor options for PostgresStorageAdapter. */
export interface PostgresStorageAdapterOptions {
  db: Db;
  accessCheck: AccessCheck;
  signingSecret: string;
}

/** The Postgres/bytea StorageAdapter used when no shared disk is available; see ./types.ts for the interface contract. */
export class PostgresStorageAdapter implements StorageAdapter {
  private readonly db: Db;
  private readonly accessCheck: AccessCheck;
  private readonly signingSecret: string;
  private lastSweepMs = -Infinity;
  private sweeping: Promise<void> = Promise.resolve();

  constructor(options: PostgresStorageAdapterOptions) {
    assertUsableSigningSecret(options.signingSecret, "PostgresStorageAdapter");
    this.db = options.db;
    this.accessCheck = options.accessCheck;
    this.signingSecret = options.signingSecret;
  }

  // Records the declared filename/type/size in the same row the bytes will later fill — confirmUpload
  // returns filename/mimeType from this row, never from whatever a later request claims. May also
  // start a sweep of abandoned uploads (see startSweepIfDue) without waiting for it.
  async createUploadTarget(
    principal: Principal,
    metadata: CreateUploadTargetInput,
  ): Promise<CreateUploadTargetResult> {
    assertUploadAllowed(metadata);
    assertSizeWithinCap(metadata.sizeBytes, POSTGRES_MAX_UPLOAD_BYTES, "this deployment");
    this.startSweepIfDue();
    const ref = buildRef(principal, metadata.filename);
    await this.db.insert(storageObjects).values({
      storageRef: ref,
      ownerPrincipalKey: principalKey(principal),
      filename: displayFilename(metadata.filename),
      mimeType: metadata.mimeType,
      declaredSizeBytes: metadata.sizeBytes,
    });
    return { method: "server-relay", ref };
  }

  // At most once per UNCONFIRMED_SWEEP_INTERVAL_MS per process, off the request's path — mirrors
  // LocalFsStorageAdapter's own best-effort sweep. Nothing in production calls
  // purgeUnconfirmedUploads on a schedule otherwise (see PostgresStoragePurger), so this is what keeps
  // abandoned rows from accumulating between real TTL-sweep runs.
  private startSweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweepMs < UNCONFIRMED_SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    const createdBefore = new Date(now - UNCONFIRMED_UPLOAD_TTL_MS - UNCONFIRMED_SWEEP_INTERVAL_MS);
    this.sweeping = sweepUnconfirmedUploads(this.db, createdBefore).then(
      () => undefined,
      (error: unknown) => {
        const errorType = error instanceof Error ? error.name : "Error";
        console.warn(JSON.stringify({ event: "unconfirmed_upload_sweep_failed", errorType }));
      },
    );
  }

  /** The last unconfirmed-upload sweep createUploadTarget started: settles when it ends, never rejects. */
  get lastSweep(): Promise<void> {
    return this.sweeping;
  }

  // Creation-time owner-prefix check: nothing at the type/runtime level otherwise stops a caller
  // handing writeRelayed one principal's `ref` under a different principal, silently writing
  // attacker-controlled bytes into the first principal's namespace. Rejects a mismatched pair before
  // the row is even touched — same guard as LocalFsStorageAdapter, before anything touches storage.
  async writeRelayed(principal: Principal, ref: string, bytes: Uint8Array): Promise<void> {
    if (!refBelongsTo(ref, principal)) {
      throw notFound();
    }
    assertWrittenSizeAllowed(bytes.byteLength);
    assertSizeWithinCap(bytes.byteLength, POSTGRES_MAX_UPLOAD_BYTES, "this deployment");
    const buf = Buffer.from(bytes);
    // INSERT-or-single-write-UPDATE in one atomic statement: a ref createUploadTarget already minted
    // hits the conflict branch, filling its still-NULL bytes exactly once (setWhere makes a second
    // writeRelayed on the same ref a no-op here, never a silent overwrite). A ref with no prior row —
    // samples/open.ts calls writeRelayed directly, never createUploadTarget — originates its own row
    // instead, matching LocalFsStorageAdapter's writeRelayed, which needs no pre-existing file either.
    const [written] = await this.db
      .insert(storageObjects)
      .values({
        storageRef: ref,
        ownerPrincipalKey: principalKey(principal),
        declaredSizeBytes: buf.byteLength,
        bytes: buf,
      })
      .onConflictDoUpdate({
        target: storageObjects.storageRef,
        set: { bytes: buf },
        setWhere: isNull(storageObjects.bytes),
      })
      .returning({ storageRef: storageObjects.storageRef });
    if (!written) {
      throw new AppError("VALIDATION_FAILED", "An object already exists at this storage ref.");
    }
  }

  async confirmUpload(principal: Principal, ref: string): Promise<ConfirmedUpload> {
    // `ref` is client-supplied here — parse strictly and translate any parse failure to the same
    // NOT_FOUND a foreign-owner ref produces, so a malformed ref never looks different from a
    // resource that doesn't exist. Mirrors LocalFsStorageAdapter's confirmUpload exactly.
    let parsed: ReturnType<typeof parseRef>;
    try {
      parsed = parseRef(ref);
    } catch {
      throw notFound();
    }
    if (parsed.principalKey !== principalKey(principal)) {
      throw notFound();
    }
    const cutoff = new Date(Date.now() - UNCONFIRMED_UPLOAD_TTL_MS);
    // One atomic conditional UPDATE: owner, bytes-written, a real upload record (filename set —
    // never true for a row writeRelayed originated on its own, see the migration's comment), one-shot
    // (confirmed_at IS NULL) and TTL are all in the same WHERE, so two concurrent confirms of the same
    // ref can never both succeed — no read-then-write race window between checking and marking confirmed.
    const [row] = await this.db
      .update(storageObjects)
      .set({ confirmedAt: sql`now()` })
      .where(
        and(
          eq(storageObjects.storageRef, ref),
          eq(storageObjects.ownerPrincipalKey, parsed.principalKey),
          isNull(storageObjects.confirmedAt),
          isNotNull(storageObjects.bytes),
          isNotNull(storageObjects.filename),
          gt(storageObjects.createdAt, cutoff),
        ),
      )
      .returning({ filename: storageObjects.filename, mimeType: storageObjects.mimeType });
    if (!row || row.filename === null || row.mimeType === null) throw notFound();
    return { filename: row.filename, mimeType: row.mimeType };
  }

  // Server-internal only — not principal-scoped (see ./types.ts). `ref` here is always server-sourced
  // (a document row's own storage_ref), so a bare keyed lookup is enough: an unrecognized string
  // simply matches no row, the same NOT_FOUND a real missing object gets, never a crash.
  async readObject(ref: string): Promise<Buffer> {
    const [row] = await this.db.select({ bytes: storageObjects.bytes }).from(storageObjects).where(eq(storageObjects.storageRef, ref));
    if (!row || row.bytes === null) throw notFound();
    return Buffer.from(row.bytes);
  }

  async getSignedUrl(principal: Principal, row: OwnedStorageRef): Promise<string> {
    if (!this.accessCheck(principal, row)) {
      throw notFound();
    }
    const [existing] = await this.db
      .select({ storageRef: storageObjects.storageRef })
      .from(storageObjects)
      .where(eq(storageObjects.storageRef, row.storageRef));
    if (!existing) throw notFound();
    const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;
    return signLocalUrl(this.signingSecret, row.storageRef, expiresAtMs);
  }

  async delete(principal: Principal, row: OwnedStorageRef): Promise<void> {
    if (!this.accessCheck(principal, row)) {
      throw notFound();
    }
    const [deleted] = await this.db
      .delete(storageObjects)
      .where(eq(storageObjects.storageRef, row.storageRef))
      .returning({ storageRef: storageObjects.storageRef });
    if (!deleted) throw notFound();
  }
}
