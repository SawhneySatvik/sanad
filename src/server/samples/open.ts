/**
 * The samples-open flow: check the entry hasn't drifted, write its bytes under a fresh ref, reserve
 * (or find) the caller's own document row, then replay the recorded analysis through the real
 * Understand persistence code — so a sample's findings are re-verified on every read exactly like
 * any other document. The only module that constructs RecordedLlmClient and calls
 * replayRecordedAnalysis; samples-isolation.test.ts pins both.
 */

import type { Db } from "@/db/client";
import { notFound } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { findOrInsertSampleDocument } from "@/server/data/sample-documents";
import * as understand from "@/server/services/understand";
import { buildRef } from "@/server/storage/refs";
import type { StorageAdapter } from "@/server/storage/types";
import { RecordedLlmClient } from "./recorded-llm-client";
import { assertSampleIsLive, getSampleEntry, sampleBytes, type SampleEntry } from "./registry";

/** What openSample()/openSampleEntry() need — the real db/storage, never the container's LLM client (samples never call it). */
export interface OpenSampleDeps {
  db: Db;
  storage: StorageAdapter;
}

// Best-effort only: an object this same call just wrote, never referenced by any row (because a
// concurrent opener's row won the race, or reservation failed outright). A fixed message only — no
// ref, no error object — matching scripts/storage-cleanup.ts's own convention.
async function cleanUpOrphanedObject(storage: StorageAdapter, principal: Principal, storageRef: string): Promise<void> {
  const owner =
    principal.type === "user"
      ? { ownerUserId: principal.userId, ownerGuestSessionId: null }
      : { ownerUserId: null, ownerGuestSessionId: principal.guestSessionId };
  await storage.delete(principal, { storageRef, ...owner }).catch(() => {
    console.error("Sample reservation cleanup failed.");
  });
}

/**
 * Opens (creating on first call, reusing after) the caller's own copy of `entry` and replays its
 * recorded analysis. Returns only the id — the client reads everything else through the
 * always-re-verify GET, never a body this route hands back directly.
 * @throws AppError NOT_FOUND if `entry` has drifted from what a live replay would rebuild.
 */
export async function openSampleEntry(deps: OpenSampleDeps, principal: Principal, entry: SampleEntry): Promise<{ documentId: string }> {
  // Checked before any row is created or any byte written — a drift refuses cleanly here, not after
  // spending a row and a storage write on a reply nothing can now vouch for.
  await assertSampleIsLive(entry);

  const storageRef = buildRef(principal, entry.filename);
  await deps.storage.writeRelayed(principal, storageRef, sampleBytes(entry));

  let reservation;
  try {
    reservation = await findOrInsertSampleDocument(deps.db, principal, {
      sampleId: entry.sampleId,
      storageRef,
      filename: entry.filename,
      mimeType: entry.mimeType,
    });
  } catch (error) {
    // The reservation never used this ref (the row-cap check, or something else, failed) — clean up
    // before propagating, so a failed open never leaks storage.
    await cleanUpOrphanedObject(deps.storage, principal, storageRef);
    throw error;
  }
  if (!reservation.created) {
    // Lost the race to a concurrent opener (or a normal re-open): this ref was never referenced.
    await cleanUpOrphanedObject(deps.storage, principal, storageRef);
  }

  const llm = new RecordedLlmClient({
    recording: entry.recording,
    expectedInputFingerprint: entry.inputFingerprint,
    expectedRecordingHash: entry.recordingHash,
  });
  // No chargeLlmCall: a sample never reads or writes the shared analysis cache, and is never
  // charged against the LLM rate-limit tiers — only the per-IP route limit and the row cap/TTL still
  // apply, both already enforced above and by route()'s own IP check.
  await understand.replayRecordedAnalysis(
    { db: deps.db, storage: deps.storage, llm, modelId: entry.modelUsed },
    principal,
    reservation.id,
    entry.sampleId,
  );

  return { documentId: reservation.id };
}

/**
 * Looks `sampleId` up in the registry and opens it. An unknown, deferred, or prompt-divergent
 * sample id is NOT_FOUND — indistinguishable from a live entry that failed its freshness check,
 * never a detail-leaking 403 shape.
 */
export async function openSample(deps: OpenSampleDeps, principal: Principal, sampleId: string): Promise<{ documentId: string }> {
  const entry = getSampleEntry(sampleId);
  if (entry === null) throw notFound();
  return openSampleEntry(deps, principal, entry);
}
