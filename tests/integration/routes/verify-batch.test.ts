// POST /api/verify-batch through the real route wiring (harness.ts): IP tier → principal → the
// VerifyBatchInput contract → verifyBatch.run → verifyBatchView → VerifyBatchOutput. verify and
// verifyMany are passthrough spies so a rejected batch can be shown to cost zero verify() calls.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as verifyBatchRoute from "@/app/api/verify-batch/route";
import * as schema from "@/db/schema";
import type { Principal } from "@/server/core/types";
import { verify, verifyMany } from "@/server/deterministic/verify";
import { readyDocument, SAMPLE_QUOTE, SAMPLE_TEXT } from "@tests/support/data/documents";
import { LEASE } from "@tests/support/services/understand";
import {
  analyzedDocumentViaRoutes,
  callRoute,
  createRouteHarness,
  guestCookie,
  LEASE_FIXTURE,
  readFixture,
  request,
  userA,
  type RouteHarness,
} from "./harness";

vi.mock("@/server/deterministic/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/deterministic/verify")>();
  return { ...actual, verify: vi.fn(actual.verify), verifyMany: vi.fn(actual.verifyMany) };
});

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

function postBatch(cookie: string | null, json: unknown): Promise<Response> {
  return callRoute(verifyBatchRoute.POST, request("POST", "/api/verify-batch", { cookie, json }));
}

async function canonicalTextOf(documentId: string): Promise<string> {
  const [row] = await h.t.db
    .select({ canonicalText: schema.documents.canonicalText })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!row?.canonicalText) throw new Error("document has no canonical text");
  return row.canonicalText;
}

function verifyCalls(): number {
  return vi.mocked(verify).mock.calls.length + vi.mocked(verifyMany).mock.calls.length;
}

describe("POST /api/verify-batch", () => {
  it("re-verifies an uploaded document's citations in request order; spanText is the canonical slice", async () => {
    const { cookie } = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(cookie);
    const canonicalText = await canonicalTextOf(documentId);

    const res = await postBatch(cookie, {
      citations: [
        { documentId, quote: LEASE.licenseFee },
        { documentId, quote: LEASE.fabricated },
        { documentId, quote: LEASE.nearMiss },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { results } = await res.json();
    expect(results.map((r: { status: string }) => r.status)).toEqual(["verified", "not_found", "approximate"]);

    const [verified, notFound, approximate] = results;
    expect(Object.keys(verified).sort()).toEqual(["spanEnd", "spanStart", "spanText", "status", "verifierVersion"]);
    expect(verified.spanText).toBe(canonicalText.slice(verified.spanStart, verified.spanEnd));
    expect(verified.spanText).toBe(LEASE.licenseFee);
    expect(notFound).toMatchObject({ spanStart: null, spanEnd: null, spanText: null, claimedQuote: LEASE.fabricated });
    expect(approximate.spanText).toBe(canonicalText.slice(approximate.spanStart, approximate.spanEnd));
    expect(approximate.claimedQuote).toBe(LEASE.nearMiss);
  });

  it("the body holds no document text beyond the spans verify() placed for the caller's own quotes", async () => {
    const { cookie, guestSessionId } = guestCookie();
    const leaseText = (await readFixture(LEASE_FIXTURE)).toString("utf8");
    const documentId = (await readyDocument(h.t, { type: "guest", guestSessionId }, leaseText)).id;
    const canonicalText = await canonicalTextOf(documentId);

    const res = await postBatch(cookie, { citations: [{ documentId, quote: LEASE.licenseFee }] });
    const raw = await res.text();

    // Positive control: the verified passage itself is there…
    expect(raw).toContain(LEASE.licenseFee);
    // …and text from elsewhere in the same document is not.
    expect(canonicalText).toContain("Anjali Deshmukh");
    expect(raw).not.toContain("Anjali Deshmukh");
    expect(raw).not.toContain(canonicalText.slice(0, 40));
  });

  it("a native_document's verbatim quote is approximate over HTTP, never verified", async () => {
    const guest = guestCookie();
    const principal: Principal = { type: "guest", guestSessionId: guest.guestSessionId };
    const native = await readyDocument(h.t, principal, SAMPLE_TEXT, "native_document");
    const text = await readyDocument(h.t, principal, SAMPLE_TEXT, "text");

    const res = await postBatch(guest.cookie, {
      citations: [
        { documentId: native.id, quote: SAMPLE_QUOTE },
        { documentId: text.id, quote: SAMPLE_QUOTE },
      ],
    });

    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results.map((r: { status: string }) => r.status)).toEqual(["approximate", "verified"]);
    expect(results[0].spanText).toBe(SAMPLE_QUOTE);
    expect(results[0].claimedQuote).toBe(SAMPLE_QUOTE);
  });

  it("a signed-in user verifies their own document", async () => {
    const doc = await readyDocument(h.t, userA);
    h.signIn(userA);
    const res = await postBatch(null, { citations: [{ documentId: doc.id, quote: SAMPLE_QUOTE }] });
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].status).toBe("verified");
  });
});

describe("POST /api/verify-batch — oversized or malformed requests are a typed 400 before any verify() call", () => {
  const VALIDATION_FAILED = { error: { code: "VALIDATION_FAILED", message: "The request could not be validated." } };
  const CONTROL_CHAR = String.fromCharCode(1); // "\u0001" in JSON: 6 bytes

  const cases: { name: string; body: (id: string) => unknown }[] = [
    {
      name: "51 citations",
      body: (id) => ({ citations: Array.from({ length: 51 }, () => ({ documentId: id, quote: SAMPLE_QUOTE })) }),
    },
    {
      name: "6 distinct documents",
      body: (id) => ({
        citations: [id, ...Array.from({ length: 5 }, () => randomUUID())].map((documentId) => ({ documentId, quote: SAMPLE_QUOTE })),
      }),
    },
    { name: "a 4001-char quote", body: (id) => ({ citations: [{ documentId: id, quote: "a".repeat(4_001) }] }) },
    { name: "a 65-char document id", body: () => ({ citations: [{ documentId: "d".repeat(65), quote: SAMPLE_QUOTE }] }) },
    {
      name: "a client-sent cached status, never read",
      body: (id) => ({ citations: [{ documentId: id, quote: SAMPLE_QUOTE, unverifiedCachedStatus: "cached_verified" }] }),
    },
    {
      name: "a client-sent status",
      body: (id) => ({ citations: [{ documentId: id, quote: SAMPLE_QUOTE, status: "verified" }] }),
    },
    { name: "no citations key", body: () => ({}) },
    {
      // 50 quotes of 4000 control characters are within every count and length cap, but each
      // character is JSON-escaped to 6 bytes (~1.2 MB): the route's 1 MiB body cap rejects it before
      // the JSON is even parsed.
      name: "a body over the 1 MiB cap",
      body: (id) => ({ citations: Array.from({ length: 50 }, () => ({ documentId: id, quote: CONTROL_CHAR.repeat(4_000) })) }),
    },
  ];

  it.each(cases)("$name", async ({ body }) => {
    const guest = guestCookie();
    const doc = await readyDocument(h.t, { type: "guest", guestSessionId: guest.guestSessionId });
    vi.clearAllMocks();

    const res = await postBatch(guest.cookie, body(doc.id));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(VALIDATION_FAILED);
    expect(verifyCalls()).toBe(0);
  });

  it("a text/plain body (a cross-site 'simple request') is a 400 before any verify() call", async () => {
    const guest = guestCookie();
    const doc = await readyDocument(h.t, { type: "guest", guestSessionId: guest.guestSessionId });
    vi.clearAllMocks();

    const bytes = new TextEncoder().encode(JSON.stringify({ citations: [{ documentId: doc.id, quote: SAMPLE_QUOTE }] }));
    const res = await callRoute(
      verifyBatchRoute.POST,
      request("POST", "/api/verify-batch", { cookie: guest.cookie, headers: { "content-type": "text/plain" }, bytes }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(VALIDATION_FAILED);
    expect(verifyCalls()).toBe(0);
  });

  // Positive control: the spies see the route's real verify work, so the zeros above are real.
  it("a valid batch over the same route is counted by the spies", async () => {
    const guest = guestCookie();
    const doc = await readyDocument(h.t, { type: "guest", guestSessionId: guest.guestSessionId });
    vi.clearAllMocks();

    const res = await postBatch(guest.cookie, { citations: [{ documentId: doc.id, quote: SAMPLE_QUOTE }] });

    expect(res.status).toBe(200);
    expect(vi.mocked(verifyMany)).toHaveBeenCalledTimes(1);
  });
});
