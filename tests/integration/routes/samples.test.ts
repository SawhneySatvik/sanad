// Opening a sample makes zero provider HTTP requests and exactly one RecordedLlmClient.complete()
// call, the finding count matches the recording, the shared analysis cache is unchanged (with a
// positive control), modelUsed fidelity, and a concurrent double-open yields exactly one document row.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as sampleOpenRoute from "@/app/api/samples/[sampleId]/open/route";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import { AppError } from "@/server/core/errors";
import { RecordedLlmClient } from "@/server/samples/recorded-llm-client";
import { allSampleEntries, sampleBytes } from "@/server/samples/registry";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

// Throws if the container's rate-limited LLM client is ever built and called — the samples-open
// route is usesLlm: false, so this must never happen at all.
function neverCalledLlm(): FakeLlmClient {
  return new FakeLlmClient({
    defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "the samples route must never call this") },
  });
}

function openSample(sampleId: string, cookie: string) {
  return callRoute(sampleOpenRoute.POST, request("POST", `/api/samples/${sampleId}/open`, { cookie }), { sampleId });
}

function getDocument(id: string, cookie: string) {
  return callRoute(documentRoute.GET, request("GET", `/api/documents/${id}`, { cookie }), { id });
}

async function cacheRows(harness: RouteHarness): Promise<unknown[]> {
  const result = await harness.t.client.query("SELECT * FROM analyzed_result_cache ORDER BY cache_key");
  return result.rows;
}

// Uploads and analyzes the SAME bytes the "lease" sample bundles — not an unrelated fixture — so
// the positive control below proves the assertion isn't vacuous for the identical text a sample
// replay is bypassing the cache for.
async function analyzeSampleTextAsAnOrdinaryUpload(cookie: string): Promise<Response> {
  const entry = allSampleEntries().find((e) => e.sampleId === "lease")!;
  const bytes = sampleBytes(entry);
  const targetRes = await callRoute(
    uploadsRoute.POST,
    request("POST", "/api/uploads", { cookie, json: { filename: entry.filename, mimeType: entry.mimeType, sizeBytes: bytes.byteLength } }),
  );
  const target = (await targetRes.json()) as { uploadUrl: string; ref: string };
  await callRoute(uploadsRelayRoute.PUT, request("PUT", target.uploadUrl, { cookie, bytes }));
  return callRoute(
    documentsRoute.POST,
    request("POST", "/api/documents", { cookie, json: { storageRef: target.ref, filename: entry.filename, mimeType: entry.mimeType } }),
  );
}

describe("POST /api/samples/:sampleId/open", () => {
  it("zero provider HTTP requests, exactly one RecordedLlmClient.complete(), and the finding count matches the recording", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();
    const completeSpy = vi.spyOn(RecordedLlmClient.prototype, "complete");

    const res = await openSample("lease", cookie);
    expect(res.status).toBe(200);
    const { documentId } = (await res.json()) as { documentId: string };

    expect(h.primary.callCount).toBe(0);
    expect(h.secondary.callCount).toBe(0);
    expect(completeSpy).toHaveBeenCalledTimes(1);

    const docRes = await getDocument(documentId, cookie);
    expect(docRes.status).toBe(200);
    const body = (await docRes.json()) as {
      analysisState: string;
      document: { sampleId: string | null };
      findings: { explanationProvenance: string }[];
    };
    expect(body.analysisState).toBe("complete");
    expect(body.document.sampleId).toBe("lease");
    const entry = allSampleEntries().find((e) => e.sampleId === "lease")!;
    const aiGenerated = body.findings.filter((f) => f.explanationProvenance === "ai_generated");
    expect(aiGenerated.length).toBe(entry.recording.findings.length);

    completeSpy.mockRestore();
  });

  it("modelUsed fidelity: the persisted and returned analysis use the registry's pinned model, never the container's", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();
    const entry = allSampleEntries().find((e) => e.sampleId === "lease")!;

    const res = await openSample("lease", cookie);
    const { documentId } = (await res.json()) as { documentId: string };

    const docRes = await getDocument(documentId, cookie);
    const body = (await docRes.json()) as { analysis: { modelUsed: string } };
    expect(body.analysis.modelUsed).toBe(entry.modelUsed);

    const persisted = await h.t.client.query<{ model_used: string }>(
      "SELECT model_used FROM analyses WHERE document_id = $1",
      [documentId],
    );
    expect(persisted.rows[0].model_used).toBe(entry.modelUsed);
  });

  it("cache unchanged after a sample open, with a positive control (a normal upload of the same text DOES write the cache)", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();

    const before = await cacheRows(h);
    const res = await openSample("lease", cookie);
    expect(res.status).toBe(200);
    const after = await cacheRows(h);
    expect(after).toEqual(before);

    // Positive control, over a fresh harness with a real (fake-provider) primary and the SAME
    // bundled text — proves the assertion above isn't vacuous: an ordinary analyze of the identical
    // text DOES write the cache.
    await h.close();
    const leaseEntry = allSampleEntries().find((e) => e.sampleId === "lease")!;
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: "fake-model", defaultResponse: { data: leaseEntry.recording } }),
    });
    const control = guestCookie();
    const beforeControl = await cacheRows(h);
    const controlRes = await analyzeSampleTextAsAnOrdinaryUpload(control.cookie);
    expect(controlRes.status).toBe(200);
    const afterControl = await cacheRows(h);
    expect(afterControl.length).toBeGreaterThan(beforeControl.length);
  });

  // PGlite serialises every transaction on its single connection regardless of what JS issues
  // concurrently, so this proves the OUTCOME (one row, not two) rather than the advisory lock's own
  // mechanism specifically — that per-owner lock key is exercised directly by
  // sample-documents.idor.test.ts (two different principals never collide) and is otherwise only
  // observable against a real, concurrent Postgres connection pool, which this suite doesn't run.
  it("two 'concurrent' opens of the same sample yield exactly one document row, never two", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();

    const [first, second] = await Promise.all([openSample("lease", cookie), openSample("lease", cookie)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { documentId: string };
    const secondBody = (await second.json()) as { documentId: string };
    expect(secondBody.documentId).toBe(firstBody.documentId);

    const count = await h.t.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM documents WHERE sample_id = 'lease'",
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("reopening an already-analyzed sample makes no further RecordedLlmClient call", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();

    const firstRes = await openSample("lease", cookie);
    const firstBody = (await firstRes.json()) as { documentId: string };

    const completeSpy = vi.spyOn(RecordedLlmClient.prototype, "complete");
    const secondRes = await openSample("lease", cookie);
    const secondBody = (await secondRes.json()) as { documentId: string };
    expect(secondBody.documentId).toBe(firstBody.documentId);
    expect(completeSpy).not.toHaveBeenCalled();
    completeSpy.mockRestore();
  });

  it("an unknown sample id is 404", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();
    const res = await openSample("no-such-sample", cookie);
    expect(res.status).toBe(404);
  });

  it("the deferred Compare sample (lease_v2) is 404", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();
    const res = await openSample("lease_v2", cookie);
    expect(res.status).toBe(404);
  });

  // Every shipped sample opens successfully — a live-tree regression net, and the vehicle for the
  // manual staleness red-proof: tampering one entry's literal in registry.ts turns only that one
  // sample's row 404 here, while the other four still pass.
  it("opens all five shipped samples successfully", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();
    for (const sampleId of ["lease", "offer_letter", "nda", "privacy_policy", "freelance"]) {
      const res = await openSample(sampleId, cookie);
      expect(res.status, `${sampleId} should open with 200`).toBe(200);
    }
  });
});
