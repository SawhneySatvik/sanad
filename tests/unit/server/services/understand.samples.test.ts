// Targeted unit coverage for the two samples seams inside understand.ts: analyzeDocument()'s
// sample_readonly guard (checked before extract()/findLatestAnalysis, never only after) and
// replayRecordedAnalysis()'s own guard against becoming a general analyzeDocument() bypass. The
// full route-level ordering proof lives in tests/integration/routes/documents.sample-readonly.test.ts;
// this file isolates understand.ts's own logic from the samples registry and route layer entirely.
// The cache-skip proofs (never read, never written) live in understand.samples.verify.test.ts —
// registered under channel 6, in a file the release-blocker `verify` filter collects.

import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
import { AppError } from "@/server/core/errors";
import { analyze, analyzeDocument, replayRecordedAnalysis } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, leaseOutput, MIME, userA, type Harness } from "@tests/support/services/understand";

let h: Harness;
afterEach(async () => {
  await h.close();
});

async function tagAsSample(documentId: string, sampleId: string): Promise<void> {
  await h.t.db.update(schema.documents).set({ sampleId }).where(eq(schema.documents.id, documentId));
}

function neverCalledLlm(): FakeLlmClient {
  return new FakeLlmClient({ defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "must never be called") } });
}

describe("analyzeDocument() refuses a sample before extract()/findLatestAnalysis ever run", () => {
  it("a sample document (already analyzed) gets 422 sample_readonly, not the existing analysis, and no model call", async () => {
    h = await createHarness();
    const seedLlm = new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: leaseOutput() } });
    const upload = await h.upload(userA, "leave_and_license.txt", MIME.txt);
    const analyzed = await analyze(h.deps(seedLlm), userA, upload);
    expect(analyzed.analysisState).toBe("complete");
    await tagAsSample(analyzed.document.id, "lease");

    const spy = neverCalledLlm();
    await expect(analyzeDocument(h.deps(spy), userA, analyzed.document.id)).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "sample_readonly",
    });
    expect(spy.callCount).toBe(0);
  });
});

describe("replayRecordedAnalysis()", () => {
  it("refuses (NOT_FOUND) when the document isn't tagged with the exact sample id given — never a general bypass", async () => {
    h = await createHarness();
    const seedLlm = new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: leaseOutput() } });
    const upload = await h.upload(userA, "leave_and_license.txt", MIME.txt);
    const analyzed = await analyze(h.deps(seedLlm), userA, upload);
    // sampleId is still null: an ordinary document, never opened as a sample.

    const spy = neverCalledLlm();
    await expect(replayRecordedAnalysis(h.deps(spy), userA, analyzed.document.id, "lease")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(spy.callCount).toBe(0);
  });
});
