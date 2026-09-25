// POST /api/verify-batch is not a "does document X contain string Y" oracle for documents the
// caller doesn't own (docs/ARCHITECTURE.md "verify-batch is principal-scoped"). A citation of
// another principal's document must come back not_found, indistinguishable from a genuine miss —
// missing, malformed, foreign or expired sources all carry the fixed sha256("") sentinel textHash,
// never a real document's hash. The caller's OWN document with an absent quote is a different case
// entirely: it carries that document's real hash, which is not an oracle (the caller already knows
// which documents it owns), and it must never be mistaken for one of the non-held probes above.

import { createHash, randomUUID } from "node:crypto";
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

// The anti-oracle sentinel: computed inline here, never imported from the source files that also
// compute it independently (verify-batch.ts's NO_TEXT, message-view.ts's UNLINKED_SOURCE) — an
// import would let a shared typo in both places pass this gate silently.
const SHA256_EMPTY = createHash("sha256").update("", "utf8").digest("hex");

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

function results(captured: Captured): { status: string; spanStart: number | null; spanEnd: number | null; spanText: string | null; claimedQuote?: string; textHash: string }[] {
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

// Asserts a not_found result carries the anti-oracle sentinel and nothing that would distinguish
// it from any other unusable source: null spans, the fixed empty-text hash.
function expectSentinelNotFound(captured: Captured): void {
  expect(captured.status).toBe(200);
  const [result] = results(captured);
  expect(result).toMatchObject({ status: "not_found", spanStart: null, spanEnd: null, spanText: null, textHash: SHA256_EMPTY });
}

// A ready document holding a fixture's text, extracted by the real extractor. Built directly rather
// than through the upload routes: this gate is about verify-batch, and shouldn't move when the
// upload or analysis routes do (verify-batch.test.ts has the end-to-end upload case).
async function fixtureDocument(guestSessionId: string, fixture: string): Promise<string> {
  const text = (await readFixture(fixture)).toString("utf8");
  return (await readyDocument(h.t, { type: "guest", guestSessionId }, text)).id;
}

// Q is in the lease and not in the NDA.
const Q = LEASE.licenseFee;

describe("verify-batch is not a content oracle for another principal's document", () => {
  it("guest: a foreign document that CONTAINS the quote answers byte-for-byte like a foreign document that doesn't, a missing id and a malformed id — never like the caller's own absent quote", async () => {
    const owner = guestCookie();
    const stranger = guestCookie();
    const intruder = guestCookie();
    const lease = await fixtureDocument(owner.guestSessionId, LEASE_FIXTURE);
    const foreignNda = await fixtureDocument(stranger.guestSessionId, "nda.txt");
    const own = await readyDocument(h.t, { type: "guest", guestSessionId: intruder.guestSessionId });

    const asOwner = await postBatch(owner.cookie, [{ documentId: lease, quote: Q }]);
    expect(asOwner.status).toBe(200);
    expect(results(asOwner)[0].status).toBe("verified");

    // Four ways of citing a quote the caller cannot use: a foreign document that genuinely
    // contains it, a foreign document that doesn't, a missing id, and a malformed one.
    const foreignContains = await postBatch(intruder.cookie, [{ documentId: lease, quote: Q }]);
    const foreignLacks = await postBatch(intruder.cookie, [{ documentId: foreignNda, quote: Q }]);
    const missing = await postBatch(intruder.cookie, [{ documentId: randomUUID(), quote: Q }]);
    const malformed = await postBatch(intruder.cookie, [{ documentId: "' OR 1=1 --", quote: Q }]);

    for (const probe of [foreignContains, foreignLacks, missing, malformed]) expectSentinelNotFound(probe);
    // The same quote throughout, so no normalization is needed: byte-for-byte identical.
    for (const probe of [foreignLacks, missing, malformed]) expect(probe).toEqual(foreignContains);

    // Positive control: the caller's OWN document with an absent quote is a different case
    // entirely — its real hash, never the sentinel, and never equal to the foreign group above.
    const ownedAbsent = await postBatch(intruder.cookie, [{ documentId: own.id, quote: Q }]);
    expect(results(ownedAbsent)[0]).toMatchObject({ status: "not_found", spanStart: null, spanEnd: null, textHash: own.canonicalTextHash });
    expect(results(ownedAbsent)[0].textHash).not.toBe(SHA256_EMPTY);
    expect(ownedAbsent).not.toEqual(foreignContains);
  });

  it("the literal gate: two non-held probes are deep-equal once only the quote text is normalized, while the caller's own absent quote keeps its own real hash", async () => {
    const owner = guestCookie();
    const intruder = guestCookie();
    const lease = await fixtureDocument(owner.guestSessionId, LEASE_FIXTURE);
    const own = await readyDocument(h.t, { type: "guest", guestSessionId: intruder.guestSessionId });

    const foreign = await postBatch(intruder.cookie, [{ documentId: lease, quote: LEASE.lockIn }]);
    const missing = await postBatch(intruder.cookie, [{ documentId: randomUUID(), quote: LEASE.fabricated }]);

    expect(results(foreign)[0].claimedQuote).toBe(LEASE.lockIn);
    expect(results(missing)[0].claimedQuote).toBe(LEASE.fabricated);
    expect(withoutQuoteText(foreign)).toEqual(withoutQuoteText(missing));
    expect(results(foreign)[0].textHash).toBe(SHA256_EMPTY);

    // Not the caller's own absent quote: same not_found status, but the real document hash.
    const ownedAbsent = await postBatch(intruder.cookie, [{ documentId: own.id, quote: LEASE.fabricated }]);
    expect(results(ownedAbsent)[0]).toMatchObject({ status: "not_found", textHash: own.canonicalTextHash });
  });

  it("in a mixed batch the foreign citation matches a missing-id entry in the same batch, not the caller's own absent entry", async () => {
    const owner = guestCookie();
    const intruder = guestCookie();
    const lease = await fixtureDocument(owner.guestSessionId, LEASE_FIXTURE);
    const intruderPrincipal: Principal = { type: "guest", guestSessionId: intruder.guestSessionId };
    const own = await readyDocument(h.t, intruderPrincipal);

    const mixed = await postBatch(intruder.cookie, [
      { documentId: own.id, quote: SAMPLE_QUOTE },
      { documentId: lease, quote: Q },
      { documentId: randomUUID(), quote: Q },
      { documentId: own.id, quote: LEASE.fabricated },
    ]);

    expect(mixed.status).toBe(200);
    const [present, foreign, missing, absent] = results(mixed);
    expect([present.status, foreign.status, missing.status, absent.status]).toEqual(["verified", "not_found", "not_found", "not_found"]);
    expect(foreign.textHash).toBe(SHA256_EMPTY);
    expect(missing.textHash).toBe(SHA256_EMPTY);
    // The foreign entry matches the missing-id entry in the SAME batch...
    expect({ ...foreign, claimedQuote: "<quote>" }).toEqual({ ...missing, claimedQuote: "<quote>" });
    // ...never the caller's own absent entry, which carries the real hash instead of the sentinel.
    expect(absent.textHash).toBe(own.canonicalTextHash);
    expect(absent.textHash).not.toBe(foreign.textHash);
  });

  it("users: another user's document, and a user's document asked by a guest, answer like a missing document — never like the caller's own absent quote", async () => {
    const theirs = await readyDocument(h.t, userB);
    const mine = await readyDocument(h.t, userA);

    h.signIn(userB);
    expect(results(await postBatch(null, [{ documentId: theirs.id, quote: SAMPLE_QUOTE }]))[0].status).toBe("verified");

    h.signIn(userA);
    const foreign = await postBatch(null, [{ documentId: theirs.id, quote: SAMPLE_QUOTE }]);
    const missingForUserA = await postBatch(null, [{ documentId: randomUUID(), quote: SAMPLE_QUOTE }]);
    expect(withoutQuoteText(foreign)).toEqual(withoutQuoteText(missingForUserA));
    expect(results(foreign)[0].textHash).toBe(SHA256_EMPTY);
    const ownedAbsent = await postBatch(null, [{ documentId: mine.id, quote: LEASE.fabricated }]);
    expect(results(ownedAbsent)[0]).toMatchObject({ status: "not_found", textHash: mine.canonicalTextHash });

    h.signIn(null);
    const guest = guestCookie();
    const guestOwn = await readyDocument(h.t, { type: "guest", guestSessionId: guest.guestSessionId });
    const fromGuest = await postBatch(guest.cookie, [{ documentId: theirs.id, quote: SAMPLE_QUOTE }]);
    const missingForGuest = await postBatch(guest.cookie, [{ documentId: randomUUID(), quote: SAMPLE_QUOTE }]);
    expect(withoutQuoteText(fromGuest)).toEqual(withoutQuoteText(missingForGuest));
    expect(results(fromGuest)[0].textHash).toBe(SHA256_EMPTY);
    const guestAbsent = await postBatch(guest.cookie, [{ documentId: guestOwn.id, quote: LEASE.fabricated }]);
    expect(results(guestAbsent)[0]).toMatchObject({ status: "not_found", textHash: guestOwn.canonicalTextHash });
  });

  it("a document the caller no longer holds (expired, not yet swept) answers like a missing document — never like the caller's own absent quote", async () => {
    const guest = guestCookie();
    const principal: Principal = { type: "guest", guestSessionId: guest.guestSessionId };
    const expiring = await readyDocument(h.t, principal);
    const own = await readyDocument(h.t, principal);

    expect(results(await postBatch(guest.cookie, [{ documentId: expiring.id, quote: SAMPLE_QUOTE }]))[0].status).toBe("verified");
    await h.t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.documents.id, expiring.id));

    const expired = await postBatch(guest.cookie, [{ documentId: expiring.id, quote: SAMPLE_QUOTE }]);
    const missing = await postBatch(guest.cookie, [{ documentId: randomUUID(), quote: SAMPLE_QUOTE }]);
    expect(withoutQuoteText(expired)).toEqual(withoutQuoteText(missing));
    expect(results(expired)[0].textHash).toBe(SHA256_EMPTY);

    const ownedAbsent = await postBatch(guest.cookie, [{ documentId: own.id, quote: LEASE.fabricated }]);
    expect(results(ownedAbsent)[0]).toMatchObject({ status: "not_found", textHash: own.canonicalTextHash });
  });
});
