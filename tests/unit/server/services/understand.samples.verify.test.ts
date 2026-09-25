// Channel 6 (Cache) registration for sample replay: the release-blocker `verify` filter only
// collects files whose path contains "verify", so the cache-skip proofs that otherwise live in
// tests/integration/routes/samples.test.ts and tests/unit/server/services/understand.samples.test.ts
// need a live copy here too. Two negatives, each with its own positive control so the assertion
// can't be vacuous: opening a sample never WRITES analyzed_result_cache, and a sample replay never
// READS an identical-text cache entry that's already warm.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { canAccess } from "@/server/data/access";
import { createPendingDocument } from "@/server/data/documents";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { openSample, type OpenSampleDeps } from "@/server/samples/open";
import { allSampleEntries, sampleBytes } from "@/server/samples/registry";
import * as understand from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { AppError } from "@/server/core/errors";
import { createHarness, leaseOutput, MIME, userA, type Harness } from "@tests/support/services/understand";

const principal: Principal = { type: "guest", guestSessionId: "understand-samples-verify-guest" };

function neverCalledLlm(): FakeLlmClient {
  return new FakeLlmClient({ defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "must never be called") } });
}

async function cacheRowCount(t: TestDb): Promise<number> {
  const result = await t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM analyzed_result_cache");
  return result.rows[0].n;
}

// --- Test (a): opening a sample never WRITES the shared cache -------------------------------

describe("opening a sample never writes analyzed_result_cache, with a positive control", () => {
  let t: TestDb;
  let rootDir: string;
  afterEach(async () => {
    await t.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("the cache table is unchanged after opening the lease sample; an ordinary analyze of the identical text DOES write it", async () => {
    t = await createTestDb();
    rootDir = await mkdtemp(path.join(tmpdir(), "understand-samples-verify-"));
    const storage = new LocalFsStorageAdapter({
      rootDir,
      signingSecret: "understand-samples-verify-signing-secret-0123456789",
      accessCheck: canAccess,
    });
    const deps: OpenSampleDeps = { db: t.db, storage };
    expect(await cacheRowCount(t)).toBe(0);

    const { documentId } = await openSample(deps, principal, "lease");
    const result = await understand.get({ db: deps.db, storage: deps.storage, llm: neverCalledLlm(), modelId: "unused" }, principal, documentId);
    expect(result.analysisState).toBe("complete");
    expect(await cacheRowCount(t)).toBe(0); // the negative: no row was written by the sample open

    // Positive control, same db/storage: a normal analyze() of the IDENTICAL bytes the lease
    // sample itself bundles (sampleBytes(), not an unrelated fixture), under a fresh principal so
    // it doesn't collide with the sample's own row, DOES write a cache row — proving the assertion
    // above isn't vacuous, and specifically that it's this exact cache key that's writable.
    const control: Principal = { type: "guest", guestSessionId: "understand-samples-verify-control" };
    const leaseEntry = allSampleEntries().find((e) => e.sampleId === "lease")!;
    const bytes = sampleBytes(leaseEntry);
    const target = await storage.createUploadTarget(control, { filename: leaseEntry.filename, mimeType: leaseEntry.mimeType, sizeBytes: bytes.byteLength });
    await storage.writeRelayed(control, target.ref, bytes);
    const controlAnalyzed = await understand.analyze(
      { db: deps.db, storage: deps.storage, llm: new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: leaseOutput() } }), modelId: "fake-model" },
      control,
      { storageRef: target.ref },
    );
    expect(controlAnalyzed.analysisState).toBe("complete");
    expect(await cacheRowCount(t)).toBe(1);
  });
});

// --- Test (b): a sample replay never READS an identical-text cache entry --------------------

async function tagAsSample(harness: Harness, documentId: string, sampleId: string): Promise<void> {
  await harness.t.db.update(schema.documents).set({ sampleId }).where(eq(schema.documents.id, documentId));
}

describe("a sample replay never reads an identical-text cache entry", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("the model is still called even though an identical-text cache entry is already warm", async () => {
    h = await createHarness();
    // Seed a cache entry a normal call to the identical text WOULD hit.
    const seedLlm = new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: leaseOutput() } });
    const seeded = await understand.analyze(h.deps(seedLlm), userA, await h.upload(userA, "leave_and_license.txt", MIME.txt));
    expect(seeded.analysisState).toBe("complete");
    const cacheRowsAfterSeed = (await h.counts()).cache;
    expect(cacheRowsAfterSeed).toBeGreaterThan(0);

    // A second, fresh document over the SAME text, tagged as a sample before it has ever been
    // analyzed — if replayRecordedAnalysis read the cache like an ordinary call, it would hit the
    // seeded entry above and never call replayLlm at all.
    const secondUpload = await h.upload(userA, "leave_and_license.txt", MIME.txt);
    const pendingDocId = (await createPendingDocument(h.t.db, userA, secondUpload)).id;
    await tagAsSample(h, pendingDocId, "lease");

    const replayLlm = new FakeLlmClient({ modelUsed: "gemini-2.5-flash", defaultResponse: { data: leaseOutput() } });
    const replayed = await understand.replayRecordedAnalysis(h.deps(replayLlm), userA, pendingDocId, "lease");

    expect(replayed.analysisState).toBe("complete");
    expect(replayLlm.callCount).toBe(1); // proves the cache read was skipped, not merely a coincidental miss
    expect((await h.counts()).cache).toBe(cacheRowsAfterSeed); // and the replay's own write is skipped too
  });
});
