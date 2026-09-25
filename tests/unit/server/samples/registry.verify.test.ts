// Sample replay is covered by the One Guarantee's existing model-response and cache channels, not a
// new one of its own. Drives the real openSample()/openSampleEntry()/replayRecordedAnalysis() path —
// never upload + analyze() — over a real PGlite db and a real LocalFsStorageAdapter. Positive: every
// non-null quote the lease sample's recording claims comes back verified, not merely "at least one
// does". Negative: a recording tampered to a fabricated quote (self-consistently rehashed, so the
// pre-replay staleness check lets it through) is stored and returned not_found for that one finding
// — verify() alone decides, exactly as it would for a live model response.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { canAccess } from "@/server/data/access";
import { openSample, openSampleEntry, type OpenSampleDeps } from "@/server/samples/open";
import { allSampleEntries, hashRecording, type RecordedUnderstandOutput } from "@/server/samples/registry";
import { AppError } from "@/server/core/errors";
import * as understand from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";

const principal: Principal = { type: "guest", guestSessionId: "registry-verify-guest" };
// get() never calls the model — it only re-verifies already-persisted quotes — so this fake exists
// purely to satisfy UnderstandDeps' type; it throws if that ever stops being true.
const neverCalledLlm = new FakeLlmClient({
  defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "get() must never call the model") },
});

let t: TestDb;
let rootDir: string;
afterEach(async () => {
  await t.close();
  await rm(rootDir, { recursive: true, force: true });
});

async function harness(): Promise<OpenSampleDeps> {
  t = await createTestDb();
  rootDir = await mkdtemp(path.join(tmpdir(), "registry-verify-"));
  const storage = new LocalFsStorageAdapter({
    rootDir,
    signingSecret: "registry-verify-test-signing-secret-0123456789",
    accessCheck: canAccess,
  });
  return { db: t.db, storage };
}

function leaseEntry() {
  const entry = allSampleEntries().find((e) => e.sampleId === "lease");
  if (!entry) throw new Error("lease entry missing from the registry");
  return entry;
}

async function getComplete(deps: OpenSampleDeps, documentId: string) {
  const result = await understand.get({ db: deps.db, storage: deps.storage, llm: neverCalledLlm, modelId: "unused" }, principal, documentId);
  if (result.analysisState !== "complete") throw new Error("expected a completed analysis");
  return result.findings.filter((f) => f.provenance === "ai_generated");
}

describe("positive: every non-null quote the lease recording claims is verified", () => {
  it("opening the lease sample through the real route verifies each one, not just some", async () => {
    const deps = await harness();
    const { documentId } = await openSample(deps, principal, "lease");
    const findings = await getComplete(deps, documentId);
    const withQuotes = findings.filter((f) => f.quote !== null);

    expect(withQuotes.length).toBe(leaseEntry().recording.findings.filter((f) => f.quote !== null).length);
    for (const finding of withQuotes) {
      expect(finding.verification?.status).toBe("verified");
    }
  });
});

describe("negative: a recording tampered to a fabricated quote is stored and returned not_found, never verified", () => {
  it("the tampered finding alone comes back not_found; every other quote in the same sample is unaffected", async () => {
    const deps = await harness();
    const real = leaseEntry();
    const fabricatedQuote = "This exact sentence never appears anywhere in the document.";
    const tamperedRecording: RecordedUnderstandOutput = {
      ...real.recording,
      findings: real.recording.findings.map((finding, i) => (i === 0 ? { ...finding, quote: fabricatedQuote } : finding)),
    };
    // Self-consistently rehashed: this test is about verify() catching a fabricated quote, not about
    // the separate tamper-detection gates (registry.test.ts / recorded-llm-client.test.ts own those).
    const tamperedEntry = { ...real, recording: tamperedRecording, recordingHash: hashRecording(tamperedRecording) };

    const { documentId } = await openSampleEntry(deps, principal, tamperedEntry);
    const findings = await getComplete(deps, documentId);

    const tamperedFinding = findings.find((f) => f.quote === fabricatedQuote);
    expect(tamperedFinding?.verification?.status).toBe("not_found");
    const anyOtherStillVerified = findings.some((f) => f.quote !== fabricatedQuote && f.verification?.status === "verified");
    expect(anyOtherStillVerified).toBe(true);
  });
});
