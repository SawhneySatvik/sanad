// POST /api/comparisons, GET /api/comparisons/:id — over real PGlite + FakeLlmClients, through the
// actual route handlers (CLAUDE.md mocking policy).

import { afterEach, describe, expect, it } from "vitest";
import * as documentsRoute from "@/app/api/documents/route";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import * as comparisonRoute from "@/app/api/comparisons/[id]/route";
import * as comparisonsRoute from "@/app/api/comparisons/route";
import { extractDocument } from "@/server/deterministic/extract";
import { explainAll, LEASE_A, LEASE_B, LEASE_CHANGES } from "@tests/support/services/compare";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

// Uploads arbitrary text content through the real upload+confirm routes (unlike
// analyzedDocumentViaRoutes, which only reads a fixture file off disk) — LEASE_B exists only as an
// in-memory string (built by editing LEASE_A in tests/support/services/compare.ts).
async function analyzeText(cookie: string | null, text: string, filename: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const targetRes = await callRoute(
    uploadsRoute.POST,
    request("POST", "/api/uploads", { cookie, json: { filename, mimeType: "text/plain", sizeBytes: bytes.byteLength } }),
  );
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as { uploadUrl: string; ref: string };
  const relayRes = await callRoute(uploadsRelayRoute.PUT, request("PUT", target.uploadUrl, { cookie, bytes }));
  expect(relayRes.status).toBe(200);
  const res = await callRoute(
    documentsRoute.POST,
    request("POST", "/api/documents", { cookie, json: { storageRef: target.ref, filename, mimeType: "text/plain" } }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { document: { id: string } }).document.id;
}

async function createComparison(cookie: string | null): Promise<{ documentAId: string; documentBId: string; body: ComparisonWithChangesOutput }> {
  const documentAId = await analyzeText(cookie, LEASE_A, "lease-a.txt");
  const documentBId = await analyzeText(cookie, LEASE_B, "lease-b.txt");
  h.primary.enqueue(explainAll());
  const res = await callRoute(
    comparisonsRoute.POST,
    request("POST", "/api/comparisons", { cookie, json: { documentAId, documentBId } }),
  );
  expect(res.status).toBe(200);
  return { documentAId, documentBId, body: (await res.json()) as ComparisonWithChangesOutput };
}

describe("POST /api/comparisons", () => {
  it("compares two documents clause by clause and returns the model that explained them", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const { documentAId, documentBId, body } = await createComparison(cookie);

    expect(body.documentAId).toBe(documentAId);
    expect(body.documentBId).toBe(documentBId);
    expect(body.modelUsed).toBe("fake-model");
    expect(body.changes).toHaveLength(LEASE_CHANGES.length);
    expect(body.changes.map((c) => c.changeType)).toEqual(LEASE_CHANGES.map((c) => c.changeType));
  });

  it("a verified change's spanText is the canonical slice of THAT side's own document", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const { body } = await createComparison(cookie);

    const changed = body.changes.find((c) => c.changeType === "changed");
    expect(changed).toBeDefined();
    expect(changed?.verificationA?.status).toBe("verified");
    expect(changed?.verificationB?.status).toBe("verified");

    const canonicalA = await extractDocument({ pastedText: LEASE_A });
    const canonicalB = await extractDocument({ pastedText: LEASE_B });
    if (canonicalA.kind !== "extracted" || canonicalB.kind !== "extracted") throw new Error("fixture did not extract");
    const a = changed!.verificationA!;
    const b = changed!.verificationB!;
    if (a.status === "verified") expect(a.spanText).toBe(canonicalA.canonicalText.slice(a.spanStart, a.spanEnd));
    if (b.status === "verified") expect(b.spanText).toBe(canonicalB.canonicalText.slice(b.spanStart, b.spanEnd));
  });

  it("identical documents cost no model call and answer modelUsed: \"none\"", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const documentAId = await analyzeText(cookie, LEASE_A, "lease-a.txt");
    const documentBId = await analyzeText(cookie, LEASE_A, "lease-a-again.txt");
    const callsBefore = h.primary.callCount;

    const res = await callRoute(comparisonsRoute.POST, request("POST", "/api/comparisons", { cookie, json: { documentAId, documentBId } }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ComparisonWithChangesOutput;
    expect(body.modelUsed).toBe("none");
    expect(body.changes).toHaveLength(0);
    expect(h.primary.callCount).toBe(callsBefore);
  });

  it("rejects a request naming the same document twice", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const documentAId = await analyzeText(cookie, LEASE_A, "lease-a.txt");

    const res = await callRoute(comparisonsRoute.POST, request("POST", "/api/comparisons", { cookie, json: { documentAId, documentBId: documentAId } }));

    expect(res.status).toBe(400);
  });

  // An untrimmed, whitespace-padded model quote that still verifies must never ride the wire
  // anywhere, on any change, verified or approximate.
  it("no field anywhere in the response ever holds the model's raw claimed quote string", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const documentAId = await analyzeText(cookie, LEASE_A, "lease-a.txt");
    const documentBId = await analyzeText(cookie, LEASE_B, "lease-b.txt");
    h.primary.enqueue(
      explainAll({
        c1: { quoteA: "   Rs.     32,000/-   " }, // verified once whitespace-normalized
        c2: { quoteA: "within 15 days after vacating the premises" }, // approximate (near-miss)
      }),
    );

    const res = await callRoute(comparisonsRoute.POST, request("POST", "/api/comparisons", { cookie, json: { documentAId, documentBId } }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ComparisonWithChangesOutput;
    const c1 = body.changes.find((c) => c.changeType === "changed" && c.verificationA?.status === "verified");
    const c2 = body.changes.find((c) => c.verificationA?.status === "approximate");
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c2?.verificationA && "claimedQuote" in c2.verificationA ? c2.verificationA.claimedQuote : undefined).toBe(
      "within 15 days after vacating the premises",
    );
    // The whitespace-padded raw model quote itself — never present anywhere, on any change.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("     32,000/-   ");
    expect(raw).not.toContain("Rs.     32,000");
    // No quoteA/quoteB key at all, on any change.
    for (const change of body.changes) {
      expect(Object.keys(change)).not.toContain("quoteA");
      expect(Object.keys(change)).not.toContain("quoteB");
    }
  });
});

describe("GET /api/comparisons/:id", () => {
  it("re-reads a comparison twice unchanged (no side effects), same shape as creation", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const { body: created } = await createComparison(cookie);

    const res = await callRoute(comparisonRoute.GET, request("GET", `/api/comparisons/${created.id}`, { cookie }), { id: created.id });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ComparisonWithChangesOutput;
    expect(body).toEqual(created);
  });

  // Comparing against `created` alone only proves get()-after-compare() is stable, not fresh
  // verification on every read. This test tampers the STORED audit columns via raw SQL, then
  // proves the response reflects a fresh re-check of the live text, not the stale stored status.
  it("a tampered stored status/span is never trusted — the route always re-verifies fresh", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const { body: created } = await createComparison(cookie);

    const changedIndex = created.changes.findIndex((c) => c.changeType === "changed");
    const changed = created.changes[changedIndex];
    expect(changed.verificationA?.status).toBe("verified");

    // Flip the true "verified" audit row to a false "not_found" with no span, directly in storage.
    await h.t.client.query(
      "UPDATE comparison_changes SET verification_status_a = 'not_found', doc_a_span_start = NULL, doc_a_span_end = NULL WHERE id = $1",
      [changed.id],
    );
    const tampered = await h.t.client.query<{ verification_status_a: string }>(
      "SELECT verification_status_a FROM comparison_changes WHERE id = $1",
      [changed.id],
    );
    expect(tampered.rows[0].verification_status_a).toBe("not_found"); // the tamper really landed

    const res = await callRoute(comparisonRoute.GET, request("GET", `/api/comparisons/${created.id}`, { cookie }), { id: created.id });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ComparisonWithChangesOutput;
    const reread = body.changes[changedIndex];
    // The route re-derives from the live canonical text and the STORED QUOTE (get()'s only input),
    // never from verification_status_a/doc_a_span_start/doc_a_span_end — so the tamper has no effect.
    expect(reread.verificationA?.status).toBe("verified");
    if (reread.verificationA?.status === "verified") {
      const canonicalA = await extractDocument({ pastedText: LEASE_A });
      if (canonicalA.kind !== "extracted") throw new Error("fixture did not extract");
      expect(reread.verificationA.spanText).toBe(
        canonicalA.canonicalText.slice(reread.verificationA.spanStart, reread.verificationA.spanEnd),
      );
    }
  });
});
