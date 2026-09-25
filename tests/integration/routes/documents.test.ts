// POST /api/documents, GET /api/documents/:id, POST /api/documents/:id/analyze — the 2xx paths,
// the analysis-state contract and the per-LLM-call principal tier, end to end through the real
// route handlers.

import { afterEach, describe, expect, it } from "vitest";
import * as documentsRoute from "@/app/api/documents/route";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as analyzeRoute from "@/app/api/documents/[id]/analyze/route";
import { ConfigError } from "@/server/core/env";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { LEASE, LEASE_FINDING_COUNT, leaseOutput } from "@tests/support/services/understand";
import { AnalyzeDocumentOutput, DocumentWithFindingsOutput } from "@/shared/contracts/documents";
import {
  analyzedDocumentViaRoutes,
  callRoute,
  createRouteHarness,
  FIXED_CLOCK,
  guestCookie,
  request,
  TEST_MODEL_ID,
  unavailable,
  uploadViaRoutes,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

function getDocument(id: string, cookie: string) {
  return callRoute(documentRoute.GET, request("GET", `/api/documents/${id}`, { cookie }), { id });
}

function retryAnalysis(id: string, cookie: string) {
  return callRoute(analyzeRoute.POST, request("POST", `/api/documents/${id}/analyze`, { cookie }), { id });
}

async function countRows(table: string): Promise<number> {
  const result = await h.t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0].n;
}

describe("POST /api/documents", () => {
  it("analyses an upload: statuses come from verify(), spanText is the stored canonical text's slice", async () => {
    h = await createRouteHarness();
    const { cookie, guestSessionId } = guestCookie();
    const input = await uploadViaRoutes(cookie);

    const res = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));

    expect(res.status).toBe(200);
    const text = await res.text();
    const raw = JSON.parse(text) as { findings: { verification: Record<string, unknown> | null }[] };
    const body = AnalyzeDocumentOutput.parse(raw);
    expect(body.analysisState).toBe("complete");
    const modelFindings = body.findings.filter((f) => f.explanationProvenance === "ai_generated");
    expect(modelFindings).toHaveLength(LEASE_FINDING_COUNT);
    expect(body.analysis.modelUsed).toBe(TEST_MODEL_ID);
    expect(modelFindings.every((f) => f.modelUsed === TEST_MODEL_ID)).toBe(true);

    // Every displayed passage is the canonical text verify() ran against, cut server-side.
    const stored = await h.t.client.query<{ canonical_text: string }>(
      "SELECT canonical_text FROM documents WHERE id = $1",
      [body.document.id],
    );
    const canonicalText = stored.rows[0].canonical_text;
    const verifications = body.findings.flatMap((f) => (f.verification ? [f.verification] : []));
    const statuses = verifications.map((v) => v.status);
    expect(statuses).toContain("verified");
    expect(statuses).toContain("not_found");
    for (const v of verifications) {
      if (v.status !== "not_found") expect(v.spanText).toBe(canonicalText.slice(v.spanStart, v.spanEnd));
    }
    const fee = verifications.find((v) => v.spanText === LEASE.licenseFee);
    expect(fee?.status).toBe("verified");
    expect(verifications).toContainEqual(expect.objectContaining({ status: "not_found", claimedQuote: LEASE.fabricated }));
    expect(body.findings.find((f) => f.category === "missing_clause")?.verification).toBeNull();

    // No raw VerifyResult on the wire: exactly the contract's keys, and no model text on a verified one.
    const keysByStatus: Record<string, string[]> = {
      verified: ["spanEnd", "spanStart", "spanText", "status", "textHash", "verifierVersion"],
      approximate: ["claimedQuote", "spanEnd", "spanStart", "spanText", "status", "textHash", "verifierVersion"],
      not_found: ["claimedQuote", "spanEnd", "spanStart", "spanText", "status", "textHash", "verifierVersion"],
    };
    for (const finding of raw.findings) {
      if (finding.verification === null) continue;
      expect(Object.keys(finding.verification).sort()).toEqual(keysByStatus[String(finding.verification.status)]);
    }
    expect(text).not.toMatch(/"(quote|canonicalText|canonicalTextHash)":/);

    // Every model explanation, finding and lens alike, is labelled model-written; every other
    // finding is a standard-clause checklist gap, labelled as such, with nothing to verify.
    const checklistFindings = body.findings.filter((f) => f.explanationProvenance !== "ai_generated");
    expect(checklistFindings.length).toBeGreaterThan(0);
    for (const finding of checklistFindings) {
      expect(finding).toMatchObject({ explanationProvenance: "checklist", category: "missing_clause", verification: null, lensExplanations: [], modelUsed: "none" });
    }
    expect(body.findings.slice(0, LEASE_FINDING_COUNT)).toEqual(modelFindings);
    const lenses = body.findings.flatMap((f) => f.lensExplanations);
    expect(lenses.length).toBeGreaterThan(0);
    expect(lenses.every((l) => l.explanationProvenance === "ai_generated")).toBe(true);

    // Server-internal fields never reach the wire: not the storage ref, not the owner.
    expect(Object.keys(body.document)).not.toContain("storageRef");
    expect(text).not.toContain(input.storageRef);
    expect(text).not.toContain(guestSessionId);
    expect(h.primary.callCount).toBe(1);
  });

  it("GET /api/documents/:id returns the same analysis, re-verified, with no model call", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const id = await analyzedDocumentViaRoutes(cookie);

    const res = await getDocument(id, cookie);

    expect(res.status).toBe(200);
    const body = DocumentWithFindingsOutput.parse(await res.json());
    expect(body.analysisState).toBe("complete");
    expect(body.findings?.filter((f) => f.explanationProvenance === "ai_generated")).toHaveLength(LEASE_FINDING_COUNT);
    expect(body.findings?.filter((f) => f.verification?.status === "verified").length).toBeGreaterThan(0);
    expect(h.primary.callCount).toBe(1);
  });

  it("a failed analysis answers with its status and the documentId; GET then shows findings: null; the retry route completes it", async () => {
    h = await createRouteHarness({
      primary: new FakeLlmClient({
        modelUsed: TEST_MODEL_ID,
        responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "primary down") }],
        defaultResponse: { data: leaseOutput() },
      }),
      secondary: unavailable(),
    });
    const { cookie } = guestCookie();
    const input = await uploadViaRoutes(cookie);

    const failed = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));
    expect(failed.status).toBe(503);
    const error = (await failed.json()) as { error: { code: string; documentId: string }; findings?: unknown };
    expect(error.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.error.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(error.findings).toBeUndefined();

    const notAnalyzed = await getDocument(error.error.documentId, cookie);
    expect(notAnalyzed.status).toBe(200);
    const pending = DocumentWithFindingsOutput.parse(await notAnalyzed.json());
    expect(pending.analysisState).toBe("not_analyzed");
    expect(pending.findings).toBeNull();
    expect(pending.analysis).toBeNull();
    expect(pending.document.processingStatus).toBe("ready");

    const retried = await retryAnalysis(error.error.documentId, cookie);
    expect(retried.status).toBe(200);
    const complete = DocumentWithFindingsOutput.parse(await retried.json());
    expect(complete.analysisState).toBe("complete");
    expect(complete.findings?.filter((f) => f.explanationProvenance === "ai_generated")).toHaveLength(LEASE_FINDING_COUNT);
  });

  it("an analysis that found nothing is findings: [] — distinct from not analysed", async () => {
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: { findings: [] } } }),
    });
    const { cookie } = guestCookie();
    // A generic document has no standard-clause checklist, so nothing is added to the model's [].
    const id = await analyzedDocumentViaRoutes(cookie, "generic.txt");

    const body = DocumentWithFindingsOutput.parse(await (await getDocument(id, cookie)).json());

    expect(body.analysisState).toBe("complete");
    expect(body.findings).toEqual([]);
  });

  it("a lease the model found nothing in still lists the checklist's gaps, labelled checklist and never verified", async () => {
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: { findings: [] } } }),
    });
    const { cookie } = guestCookie();
    const id = await analyzedDocumentViaRoutes(cookie);

    const res = await getDocument(id, cookie);

    const text = await res.text();
    const body = DocumentWithFindingsOutput.parse(JSON.parse(text));
    expect(body.findings?.length).toBeGreaterThan(0);
    for (const finding of body.findings ?? []) {
      expect(Object.keys(finding).sort()).toEqual(["category", "explanation", "explanationProvenance", "id", "lensExplanations", "modelUsed", "verification"]);
      expect(finding).toMatchObject({ explanationProvenance: "checklist", category: "missing_clause", verification: null });
    }
    expect(text).not.toMatch(/"(quote|status)":/);
  });

  it("the retry route on an analysed document returns it without a model call", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const id = await analyzedDocumentViaRoutes(cookie);

    const res = await retryAnalysis(id, cookie);

    expect(res.status).toBe(200);
    expect(DocumentWithFindingsOutput.parse(await res.json()).analysisState).toBe("complete");
    expect(h.primary.callCount).toBe(1);
  });

  it.each([
    ["a client-supplied status", { status: "verified" }],
    ["a client-supplied canonicalText", { canonicalText: "anything" }],
    ["a client-supplied finding list", { findings: [{ quote: "x", status: "verified" }] }],
  ])("rejects %s with a 400 and creates nothing", async (_label, extra) => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const input = await uploadViaRoutes(cookie);

    const res = await callRoute(
      documentsRoute.POST,
      request("POST", "/api/documents", { cookie, json: { ...input, ...extra } }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    expect(await countRows("documents")).toBe(0);
    expect(h.primary.callCount).toBe(0);
  });

  it("rejects a body that is not JSON, or misses a field, with a 400", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const notJson = new Request("http://localhost/api/documents", { method: "POST", headers: { cookie }, body: "{nope" });
    const missing = request("POST", "/api/documents", { cookie, json: { storageRef: "x", filename: "a.txt" } });

    const responses = [await callRoute(documentsRoute.POST, notJson), await callRoute(documentsRoute.POST, missing)];

    expect(responses.map((r) => r.status)).toEqual([400, 400]);
  });
});

describe("a missing provider key fails before the service writes anything", () => {
  it("POST /api/documents is a 500 with no document row and the ref unspent; once configured, the same ref succeeds", async () => {
    let configured = false;
    h = await createRouteHarness({
      providers: () => {
        // What createGemmaClient() throws when NVIDIA_API_KEY is unset.
        if (!configured) throw new ConfigError("NVIDIA_API_KEY");
        return { primary: h.primary, secondary: h.secondary };
      },
    });
    const { cookie } = guestCookie();
    const input = await uploadViaRoutes(cookie);

    const failed = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));

    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: { code: string; documentId?: string } }).error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
    });
    expect(await countRows("documents")).toBe(0);

    configured = true;
    const retried = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));
    expect(retried.status).toBe(200);
    expect(await countRows("documents")).toBe(1);
  });

  it("a read declared usesLlm: false reaches its service without provider keys; an LLM route does not", async () => {
    h = await createRouteHarness({
      providers: () => {
        throw new ConfigError("GEMINI_API_KEY");
      },
    });
    const { cookie } = guestCookie();
    const id = "0a0a0a0a-0000-4000-8000-00000000000a";

    // The read's service ran (and found nothing): a 404, not the providers' 500.
    expect((await getDocument(id, cookie)).status).toBe(404);
    // The retry route builds its providers first: a 500 before its service runs.
    expect((await retryAnalysis(id, cookie)).status).toBe(500);
  });
});

describe("rate limiting on LLM routes", () => {
  it("charges the principal per LLM call — a second analysis is 429 with Retry-After and its documentId — and never on GET", async () => {
    h = await createRouteHarness({ rateLimits: { principalPerMinute: 1, clock: FIXED_CLOCK } });
    const { cookie } = guestCookie();
    const firstId = await analyzedDocumentViaRoutes(cookie);
    // A different text: the same one would hit the analysis cache and make no LLM call at all.
    const input = await uploadViaRoutes(cookie, "nda.txt");

    const limited = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    const body = (await limited.json()) as { error: { code: string; documentId?: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.primary.callCount).toBe(1);

    // Reads make no LLM call, so they are never principal-charged, however many GETs follow: the
    // per-minute bucket stays at the two charges above (one allowed, one rejected), and the daily
    // one (`day:`-prefixed) at the one allowed call — the rejected one never reached it.
    for (let i = 0; i < 3; i++) expect((await getDocument(firstId, cookie)).status).toBe(200);
    const buckets = await h.t.client.query<{ daily: boolean; total: number }>(
      "SELECT principal_key LIKE 'day:%' AS daily, sum(request_count)::int AS total FROM rate_limit_buckets GROUP BY 1 ORDER BY 1",
    );
    expect(buckets.rows).toEqual([
      { daily: false, total: 2 },
      { daily: true, total: 1 },
    ]);
  });
});
