// POST /api/verify-batch is not a "does document X contain string Y" oracle for documents the
// caller doesn't own (docs/ARCHITECTURE.md "verify-batch is principal-scoped"). A citation of
// another principal's document must come back not_found, indistinguishable from a genuine miss.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as verifyBatchRoute from "@/app/api/verify-batch/route";
import * as schema from "@/db/schema";
import type { Principal } from "@/server/core/types";
import { readyDocument, SAMPLE_QUOTE } from "@tests/support/data/documents";
import { LEASE } from "@tests/support/services/understand";
import {
  callRoute,
  createRouteHarness,
  guestCookie,
  LEASE_FIXTURE,
  readFixture,
  request,
  userA,
  userB,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

interface Citation {
  documentId: string;
  quote: string;
}

interface Captured {
  status: number;
  headers: [string, string][];
  body: string;
}

async function postBatch(cookie: string | null, citations: Citation[]): Promise<Captured> {
  const res = await callRoute(verifyBatchRoute.POST, request("POST", "/api/verify-batch", { cookie, json: { citations } }));
  return { status: res.status, headers: [...res.headers], body: await res.text() };
}

function results(captured: Captured): { status: string; claimedQuote?: string }[] {
  return JSON.parse(captured.body).results;
}

// The gate's one allowed normalization: the quote text the caller sent, echoed as claimedQuote.
function withoutQuoteText(captured: Captured) {
  return {
    status: captured.status,
    headers: captured.headers,
    results: results(captured).map((result) => ({ ...result, claimedQuote: "<quote>" })),
  };
}

// A ready document holding a fixture's text, extracted by the real extractor. Built directly rather
// than through the upload routes: this gate is about verify-batch, and shouldn't move when the
// upload or analysis routes do (verify-batch.test.ts has the end-to-end upload case).
async function fixtureDocument(guestSessionId: string, fixture: string): Promise<string> {
  const text = (await readFixture(fixture)).toString("utf8");
  return (await readyDocument(h.t, { type: "guest", guestSessionId }, text)).id;
}

// Q is in the lease and not in the NDA. The strongest form of the gate: the intruder asks for the
// SAME quote against the lease (someone else's, where it exists) and against their own NDA (where
// it doesn't) — the two responses must be byte-identical with no normalization at all.
const Q = LEASE.licenseFee;

describe("verify-batch is not a content oracle for another principal's document", () => {
  it("guest: a foreign document that CONTAINS the quote answers byte-for-byte like the caller's own document that doesn't", async () => {
    const owner = guestCookie();
    const intruder = guestCookie();
    const lease = await fixtureDocument(owner.guestSessionId, LEASE_FIXTURE);
    const nda = await fixtureDocument(intruder.guestSessionId, "nda.txt");

    const asOwner = await postBatch(owner.cookie, [{ documentId: lease, quote: Q }]);
    expect(asOwner.status).toBe(200);
    expect(results(asOwner)[0].status).toBe("verified");

    const foreign = await postBatch(intruder.cookie, [{ documentId: lease, quote: Q }]);
    const ownedAbsent = await postBatch(intruder.cookie, [{ documentId: nda, quote: Q }]);
    const missing = await postBatch(intruder.cookie, [{ documentId: randomUUID(), quote: Q }]);
    const malformed = await postBatch(intruder.cookie, [{ documentId: "' OR 1=1 --", quote: Q }]);

    expect(ownedAbsent.status).toBe(200);
    expect(results(ownedAbsent)[0].status).toBe("not_found");
    for (const probe of [foreign, missing, malformed]) expect(probe).toEqual(ownedAbsent);
  });

  it("the literal gate: foreign-document and absent-quote responses are deep-equal once only the quote text is normalized", async () => {
    const owner = guestCookie();
    const intruder = guestCookie();
    const lease = await fixtureDocument(owner.guestSessionId, LEASE_FIXTURE);
    const nda = await fixtureDocument(intruder.guestSessionId, "nda.txt");

    const foreign = await postBatch(intruder.cookie, [{ documentId: lease, quote: LEASE.lockIn }]);
    const ownedAbsent = await postBatch(intruder.cookie, [{ documentId: nda, quote: LEASE.fabricated }]);

    expect(results(foreign)[0].claimedQuote).toBe(LEASE.lockIn);
    expect(results(ownedAbsent)[0].claimedQuote).toBe(LEASE.fabricated);
    expect(withoutQuoteText(foreign)).toEqual(withoutQuoteText(ownedAbsent));
  });

  it("in a mixed batch the foreign citation is just another not_found, in its own position", async () => {
    const owner = guestCookie();
    const intruder = guestCookie();
    const lease = await fixtureDocument(owner.guestSessionId, LEASE_FIXTURE);
    const intruderPrincipal: Principal = { type: "guest", guestSessionId: intruder.guestSessionId };
    const own = await readyDocument(h.t, intruderPrincipal);

    const mixed = await postBatch(intruder.cookie, [
      { documentId: own.id, quote: SAMPLE_QUOTE },
      { documentId: lease, quote: Q },
      { documentId: own.id, quote: LEASE.fabricated },
    ]);

    expect(mixed.status).toBe(200);
    const [present, foreign, absent] = results(mixed);
    expect([present.status, foreign.status, absent.status]).toEqual(["verified", "not_found", "not_found"]);
    expect({ ...foreign, claimedQuote: "<quote>" }).toEqual({ ...absent, claimedQuote: "<quote>" });
  });

  it("users: another user's document, and a user's document asked by a guest, answer like an absent quote", async () => {
    const theirs = await readyDocument(h.t, userB);
    const mine = await readyDocument(h.t, userA);

    h.signIn(userB);
    expect(results(await postBatch(null, [{ documentId: theirs.id, quote: SAMPLE_QUOTE }]))[0].status).toBe("verified");

    h.signIn(userA);
    const foreign = await postBatch(null, [{ documentId: theirs.id, quote: SAMPLE_QUOTE }]);
    const ownedAbsent = await postBatch(null, [{ documentId: mine.id, quote: LEASE.fabricated }]);
    expect(withoutQuoteText(foreign)).toEqual(withoutQuoteText(ownedAbsent));

    h.signIn(null);
    const guest = guestCookie();
    const guestOwn = await readyDocument(h.t, { type: "guest", guestSessionId: guest.guestSessionId });
    const fromGuest = await postBatch(guest.cookie, [{ documentId: theirs.id, quote: SAMPLE_QUOTE }]);
    const guestAbsent = await postBatch(guest.cookie, [{ documentId: guestOwn.id, quote: LEASE.fabricated }]);
    expect(withoutQuoteText(fromGuest)).toEqual(withoutQuoteText(guestAbsent));
  });

  it("a document the caller no longer holds (expired, not yet swept) answers like an absent quote", async () => {
    const guest = guestCookie();
    const principal: Principal = { type: "guest", guestSessionId: guest.guestSessionId };
    const expiring = await readyDocument(h.t, principal);
    const own = await readyDocument(h.t, principal);

    expect(results(await postBatch(guest.cookie, [{ documentId: expiring.id, quote: SAMPLE_QUOTE }]))[0].status).toBe("verified");
    await h.t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.documents.id, expiring.id));

    const expired = await postBatch(guest.cookie, [{ documentId: expiring.id, quote: SAMPLE_QUOTE }]);
    const ownedAbsent = await postBatch(guest.cookie, [{ documentId: own.id, quote: LEASE.fabricated }]);
    expect(withoutQuoteText(expired)).toEqual(withoutQuoteText(ownedAbsent));
  });
});
