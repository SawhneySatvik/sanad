// Cross-principal access through the comparison routes: a comparison naming another principal's
// document on EITHER side is NOT_FOUND, indistinguishable from a missing or malformed id, and never
// spends a model call.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as documentsRoute from "@/app/api/documents/route";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import * as comparisonRoute from "@/app/api/comparisons/[id]/route";
import * as comparisonsRoute from "@/app/api/comparisons/route";
import { explainAll, LEASE_A, LEASE_B } from "@tests/support/services/compare";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import { callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

async function analyzeText(cookie: string | null, text: string, filename: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const targetRes = await callRoute(
    uploadsRoute.POST,
    request("POST", "/api/uploads", { cookie, json: { filename, mimeType: "text/plain", sizeBytes: bytes.byteLength } }),
  );
  const target = (await targetRes.json()) as { uploadUrl: string; ref: string };
  await callRoute(uploadsRelayRoute.PUT, request("PUT", target.uploadUrl, { cookie, bytes }));
  const res = await callRoute(
    documentsRoute.POST,
    request("POST", "/api/documents", { cookie, json: { storageRef: target.ref, filename, mimeType: "text/plain" } }),
  );
  return ((await res.json()) as { document: { id: string } }).document.id;
}

async function statusAndBody(res: Response): Promise<[number, string]> {
  return [res.status, await res.text()];
}

function postComparison(cookie: string | null, documentAId: string, documentBId: string) {
  return callRoute(comparisonsRoute.POST, request("POST", "/api/comparisons", { cookie, json: { documentAId, documentBId } }));
}

describe("POST /api/comparisons — a comparison naming another principal's document is NOT_FOUND", () => {
  it("guest: user A's document on either side is the same 404 a missing/malformed one is; own documents on both sides succeed", async () => {
    h = await createRouteHarness();
    const owner = guestCookie();
    const intruder = guestCookie();
    const ownerDoc = await analyzeText(owner.cookie, LEASE_A, "a.txt");
    const ownerDoc2 = await analyzeText(owner.cookie, LEASE_B, "a2.txt");
    const intruderDoc = await analyzeText(intruder.cookie, LEASE_B, "b.txt");
    const callsBefore = h.primary.callCount;

    // Foreign on the B side, then on the A side — both must be checked, not just the first-named one.
    const foreignB = await statusAndBody(await postComparison(intruder.cookie, intruderDoc, ownerDoc));
    const foreignA = await statusAndBody(await postComparison(intruder.cookie, ownerDoc, intruderDoc));
    // Foreign on both sides at once — never a partial pass.
    const bothForeign = await statusAndBody(await postComparison(intruder.cookie, ownerDoc, ownerDoc2));
    const missing = await statusAndBody(await postComparison(intruder.cookie, intruderDoc, randomUUID()));
    const malformed = await statusAndBody(await postComparison(intruder.cookie, intruderDoc, "not-a-uuid"));

    expect(foreignB[0]).toBe(404);
    expect(JSON.parse(foreignB[1])).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });
    expect(foreignA).toEqual(foreignB);
    expect(bothForeign).toEqual(foreignB);
    expect(missing).toEqual(foreignB);
    expect(malformed).toEqual(foreignB);
    expect(h.primary.callCount).toBe(callsBefore);

    // Positive control: the intruder comparing two of their own documents succeeds.
    const ownSecond = await analyzeText(intruder.cookie, LEASE_A, "b2.txt");
    h.primary.enqueue(explainAll());
    expect((await postComparison(intruder.cookie, intruderDoc, ownSecond)).status).toBe(200);
  });

  it("user: another user's document on either side is NOT_FOUND; the owner's own pair succeeds", async () => {
    h = await createRouteHarness();
    h.signIn(userA);
    const aDoc = await analyzeText(null, LEASE_A, "a.txt");
    h.signIn(userB);
    const bDoc = await analyzeText(null, LEASE_B, "b.txt");
    const bSecond = await analyzeText(null, LEASE_A, "b2.txt");

    const asA = await statusAndBody(await postComparison(null, aDoc, bDoc));
    expect(asA[0]).toBe(404);

    h.signIn(userA);
    const other = await statusAndBody(await postComparison(null, bDoc, aDoc));
    expect(other).toEqual(asA);

    h.signIn(userB);
    h.primary.enqueue(explainAll());
    expect((await postComparison(null, bDoc, bSecond)).status).toBe(200);
  });
});

describe("GET /api/comparisons/:id — cross-principal", () => {
  it("a foreign, missing and malformed comparison id are the same 404; the owner still reads it", async () => {
    h = await createRouteHarness();
    const owner = guestCookie();
    const intruder = guestCookie();
    const a = await analyzeText(owner.cookie, LEASE_A, "a.txt");
    const b = await analyzeText(owner.cookie, LEASE_B, "b.txt");
    h.primary.enqueue(explainAll());
    const created = (await (await postComparison(owner.cookie, a, b)).json()) as ComparisonWithChangesOutput;

    async function attempt(id: string, cookie: string | null) {
      const res = await callRoute(comparisonRoute.GET, request("GET", `/api/comparisons/${id}`, { cookie }), { id });
      return statusAndBody(res);
    }

    const foreign = await attempt(created.id, intruder.cookie);
    const missing = await attempt(randomUUID(), intruder.cookie);
    const malformed = await attempt("not-a-uuid", intruder.cookie);

    expect(foreign[0]).toBe(404);
    expect(missing).toEqual(foreign);
    expect(malformed).toEqual(foreign);
    expect((await attempt(created.id, owner.cookie))[0]).toBe(200);
  });
});
