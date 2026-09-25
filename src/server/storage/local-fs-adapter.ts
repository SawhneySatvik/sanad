/**
 * Local filesystem StorageAdapter — the local half of the app's one acknowledged local/prod
 * divergence (server-relay upload, not a direct signed PUT). See ./types.ts for the interface
 * contract this satisfies. Its root is runtime data, not source, so the paths built from it are
 * marked turbopackIgnore: the build must not trace the project through them.
 */

import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertUploadAllowed, assertWrittenSizeAllowed, displayFilename, UNCONFIRMED_UPLOAD_TTL_MS } from "./policy";
import { buildRef, parseRef, principalKey, refBelongsTo, refToPath } from "./refs";
import { assertUsableSigningSecret, signLocalUrl } from "./signed-url";
import type {
  AccessCheck,
  ConfirmedUpload,
  CreateUploadTargetInput,
  CreateUploadTargetResult,
  OwnedStorageRef,
  StorageAdapter,
} from "./types";
import {
  CONFIRMED_MARKER_FILENAME,
  readUploadRecord,
  sweepUnconfirmedUploads,
  UPLOAD_RECORD_FILENAME,
  writeUploadRecord,
} from "./upload-records";

/** Default local filesystem root for stored objects. */
export const DEFAULT_ROOT_DIR = ".local-storage";
const SIGNED_URL_TTL_MS = 15 * 60 * 1000; // 15 minutes — arbitrary, local-only.

/**
 * How often createUploadTarget sweeps uploads never confirmed. Each sweep takes those that became
 * unconfirmable at least one interval ago, so a confirm already past its age check can't race it.
 */
export const UNCONFIRMED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Constructor options for LocalFsStorageAdapter. */
export interface LocalFsStorageAdapterOptions {
  accessCheck: AccessCheck;
  rootDir?: string;
  // Required, not defaulted: validated at construction time (see signed-url.ts's
  // assertUsableSigningSecret), mirroring src/server/auth/session.ts's GUEST_SESSION_SECRET floor.
  signingSecret: string;
}

// Resolves ref -> absolute path, translating any malformed-ref failure into the same NOT_FOUND shape
// a real missing-object failure would produce — never a VALIDATION_FAILED leaking a distinguishable
// "this ref doesn't parse" signal.
function resolvePathOrNotFound(root: string, ref: string): string {
  try {
    return refToPath(root, ref);
  } catch {
    throw notFound();
  }
}

/** The local-filesystem StorageAdapter used in dev; see ./types.ts for the interface contract. */
export class LocalFsStorageAdapter implements StorageAdapter {
  private readonly accessCheck: AccessCheck;
  private readonly rootDir: string;
  private readonly signingSecret: string;
  private lastSweepMs = -Infinity;
  private sweeping: Promise<void> = Promise.resolve();

  constructor(options: LocalFsStorageAdapterOptions) {
    assertUsableSigningSecret(options.signingSecret, "LocalFsStorageAdapter");
    this.accessCheck = options.accessCheck;
    this.rootDir = path.resolve(/*turbopackIgnore: true*/ options.rootDir ?? DEFAULT_ROOT_DIR);
    this.signingSecret = options.signingSecret;
  }

  // Records the declared filename and type beside the object-to-be: confirmUpload returns those,
  // so a document never takes a type or name from the later request that confirms it. Each call
  // may also start a sweep of abandoned uploads — no row points at them, so nothing else ever
  // deletes them — without waiting for it.
  async createUploadTarget(
    principal: Principal,
    metadata: CreateUploadTargetInput,
  ): Promise<CreateUploadTargetResult> {
    assertUploadAllowed(metadata);
    this.startSweepIfDue();
    const ref = buildRef(principal, metadata.filename);
    await writeUploadRecord(refToPath(this.rootDir, ref), {
      filename: displayFilename(metadata.filename),
      mimeType: metadata.mimeType,
    });
    return { method: "server-relay", ref };
  }

  // At most once per UNCONFIRMED_SWEEP_INTERVAL_MS per process, off the request's path. The sweep
  // handles its own failure — logged, never an unhandled rejection — and the next one retries it.
  private startSweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweepMs < UNCONFIRMED_SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    const createdBefore = new Date(now - UNCONFIRMED_UPLOAD_TTL_MS - UNCONFIRMED_SWEEP_INTERVAL_MS);
    this.sweeping = sweepUnconfirmedUploads(this.rootDir, createdBefore).then(
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
  // handing `writeRelayed` one principal's `ref` under a different principal, silently writing
  // attacker-controlled bytes into the first principal's namespace. Rejects a mismatched pair before
  // anything touches disk.
  async writeRelayed(principal: Principal, ref: string, bytes: Uint8Array): Promise<void> {
    if (!refBelongsTo(ref, principal)) {
      throw notFound();
    }
    assertWrittenSizeAllowed(bytes.byteLength);
    const target = refToPath(this.rootDir, ref);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      // Exclusive create: the object is single-write while it exists — a second write to the same
      // ref would let stored bytes change out from under an already-extracted `canonical_text`
      // unnoticed. Not single-write forever: `delete()` removes the object, and reusing its exact
      // ref afterward would succeed again, but nothing legitimately re-uses a ref after its row is gone.
      await fs.writeFile(target, bytes, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AppError("VALIDATION_FAILED", "An object already exists at this storage ref.");
      }
      throw err;
    }
  }

  async confirmUpload(principal: Principal, ref: string): Promise<ConfirmedUpload> {
    // `ref` is client-supplied here — parse strictly and translate any parse failure to the same
    // NOT_FOUND a foreign-owner ref produces, so a malformed ref never looks different from a
    // resource that doesn't exist.
    let parsed: ReturnType<typeof parseRef>;
    try {
      parsed = parseRef(ref);
    } catch {
      throw notFound();
    }
    if (parsed.principalKey !== principalKey(principal)) {
      throw notFound();
    }
    const target = refToPath(this.rootDir, ref);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw notFound();
    }
    // Checked before the marker is written: an upload past its TTL is one the sweep may delete.
    const upload = await readUploadRecord(target);
    if (upload === null || Date.now() - upload.createdAt.getTime() > UNCONFIRMED_UPLOAD_TTL_MS) {
      throw notFound();
    }
    // One-shot: see CONFIRMED_MARKER_FILENAME. `wx` makes this atomic — no read-then-write race
    // between two concurrent confirms of the same ref.
    const markerPath = path.join(path.dirname(target), CONFIRMED_MARKER_FILENAME);
    try {
      await fs.writeFile(markerPath, "", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw notFound();
      }
      throw err;
    }
    return upload.record;
  }

  async readObject(ref: string): Promise<Buffer> {
    const target = resolvePathOrNotFound(this.rootDir, ref);
    try {
      return await fs.readFile(/*turbopackIgnore: true*/ target);
    } catch {
      throw notFound();
    }
  }

  async getSignedUrl(principal: Principal, row: OwnedStorageRef): Promise<string> {
    if (!this.accessCheck(principal, row)) {
      throw notFound();
    }
    const target = resolvePathOrNotFound(this.rootDir, row.storageRef);
    const stat = await fs.stat(/*turbopackIgnore: true*/ target).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw notFound();
    }
    const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;
    return signLocalUrl(this.signingSecret, row.storageRef, expiresAtMs);
  }

  async delete(principal: Principal, row: OwnedStorageRef): Promise<void> {
    if (!this.accessCheck(principal, row)) {
      throw notFound();
    }
    const target = resolvePathOrNotFound(this.rootDir, row.storageRef);
    try {
      await fs.unlink(target);
    } catch {
      throw notFound();
    }
    // Best-effort: clears the one-shot confirm marker and the upload record alongside the object so
    // neither outlives the thing it describes. Never fails the delete if this part fails (either may
    // legitimately not exist — e.g. deleting a never-confirmed upload).
    for (const file of [CONFIRMED_MARKER_FILENAME, UPLOAD_RECORD_FILENAME]) {
      await fs.rm(path.join(path.dirname(target), file), { force: true }).catch(() => undefined);
    }
  }
}
