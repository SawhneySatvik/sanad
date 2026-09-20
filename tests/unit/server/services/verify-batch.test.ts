// verify-batch service against real PGlite, the real repositories and the real verify(). verify,
// verifyMany and getDocument are wrapped in passthrough spies (vi.fn(actual)) so "zero verify()
// calls before the caps reject" and "each document is read once" are observable. That a foreign
// document's text is never selected is proven on the SQL itself in
// tests/unit/server/data/documents.foreign-text.idor.test.ts.

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { MAX_QUOTE_CHARS, MAX_QUOTES_PER_CALL, verify, verifyMany } from "@/server/deterministic/verify";
import { getDocument, markDocumentExtractionFailed } from "@/server/data/documents";
import {
  caught,
  createRepoTestDb,
  guestA,
  guestB,
  pendingDocument,
  readyDocument,
  SAMPLE_QUOTE,
  userA,
  userB,
} from "@tests/support/data/documents";
import { MAX_BATCH_CITATIONS, MAX_BATCH_DOCUMENTS, MIN_RESPONSE_MS, run, type CitationToVerify } from "@/server/services/verify-batch";

vi.mock("@/server/deterministic/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/deterministic/verify")>();
  return { ...actual, verify: vi.fn(actual.verify), verifyMany: vi.fn(actual.verifyMany) };
});
vi.mock("@/server/data/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/data/documents")>();
  return { ...actual, getDocument: vi.fn(actual.getDocument) };
});

const ABSENT_QUOTE = "The Licensor shall pay the Licensee a relocation allowance of Rs. 50,000";
const EMPTY_TEXT_HASH = createHash("sha256").update("", "utf8").digest("hex");

let t: TestDb;
beforeAll(async () => {
  t = await createRepoTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

function batch(principal: Principal, citations: CitationToVerify[]) {
  return run({ db: t.db }, principal, { citations });
}

function callCounts() {
  return {
    verify: vi.mocked(verify).mock.calls.length,
    verifyMany: vi.mocked(verifyMany).mock.calls.length,
    getDocument: vi.mocked(getDocument).mock.calls.length,
  };
}

async function expire(documentId: string): Promise<void> {
  await t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.documents.id, documentId));
}

describe("verifyBatch.run — owned documents", () => {
  it("verifies a quote against the document's live canonical text and input mode, with verify()'s own span", async () => {
    const doc = await readyDocument(t, guestA);
    const { results } = await batch(guestA, [{ documentId: doc.id, quote: SAMPLE_QUOTE }]);

    expect(results).toHaveLength(1);
    const [{ quote, verification, source }] = results;
    expect(verification.status).toBe("verified");
    expect(quote).toBe(SAMPLE_QUOTE);
    expect(source).toEqual({ canonicalText: doc.canonicalText, canonicalTextHash: doc.canonicalTextHash, inputMode: "text" });
    if (verification.status !== "verified") throw new Error("unreachable");
    expect(source.canonicalText.slice(verification.spanStart, verification.spanEnd)).toBe(SAMPLE_QUOTE);
    expect(vi.mocked(verifyMany).mock.calls).toEqual([[[SAMPLE_QUOTE], doc.canonicalText, "text"]]);
  });

  it("a quote the owned document doesn't contain is not_found", async () => {
    const doc = await readyDocument(t, guestA);
    const { results } = await batch(guestA, [{ documentId: doc.id, quote: ABSENT_QUOTE }]);
    expect(results[0].verification.status).toBe("not_found");
    expect(results[0].source.canonicalText).toBe(doc.canonicalText);
  });

  it("a native_document's exact quote caps at approximate, never verified — the same text as `text` verifies", async () => {
    const native = await readyDocument(t, guestA, undefined, "native_document");
    const text = await readyDocument(t, guestA);
    const { results } = await batch(guestA, [
      { documentId: native.id, quote: SAMPLE_QUOTE },
      { documentId: text.id, quote: SAMPLE_QUOTE },
    ]);

    expect(results.map((r) => r.verification.status)).toEqual(["approximate", "verified"]);
    expect(results[0].source.inputMode).toBe("native_document");
    expect(vi.mocked(verifyMany).mock.calls.map((call) => call[2])).toEqual(["native_document", "text"]);
  });
});

describe("verifyBatch.run — documents the caller can't use are not_found, never an error", () => {
  const cases: { name: string; setup: () => Promise<{ caller: Principal; documentId: string }> }[] = [
    {
      name: "another guest's document (which DOES contain the quote)",
      setup: async () => ({ caller: guestA, documentId: (await readyDocument(t, guestB)).id }),
    },
    {
      name: "another user's document",
      setup: async () => ({ caller: userA, documentId: (await readyDocument(t, userB)).id }),
    },
    {
      name: "a user's document, asked by a guest",
      setup: async () => ({ caller: guestA, documentId: (await readyDocument(t, userA)).id }),
    },
    { name: "a missing id", setup: async () => ({ caller: guestA, documentId: randomUUID() }) },
    { name: "a malformed id", setup: async () => ({ caller: guestA, documentId: "' OR 1=1 --" }) },
    {
      name: "the caller's own document, still pending",
      setup: async () => ({ caller: guestA, documentId: (await pendingDocument(t, guestA)).id }),
    },
    {
      name: "the caller's own document, extraction failed",
      setup: async () => {
        const doc = await pendingDocument(t, guestA);
        await markDocumentExtractionFailed(t.db, guestA, doc.id);
        return { caller: guestA, documentId: doc.id };
      },
    },
    {
      name: "the caller's own document, expired but not yet swept",
      setup: async () => {
        const doc = await readyDocument(t, guestA);
        await expire(doc.id);
        return { caller: guestA, documentId: doc.id };
      },
    },
  ];

  it.each(cases)("$name", async ({ setup }) => {
    const { caller, documentId } = await setup();
    const owned = await readyDocument(t, caller);
    vi.clearAllMocks();

    const { results } = await batch(caller, [
      { documentId, quote: SAMPLE_QUOTE },
      { documentId, quote: ABSENT_QUOTE },
      { documentId: owned.id, quote: ABSENT_QUOTE },
    ]);

    for (const { verification, source } of results.slice(0, 2)) {
      expect(verification.status).toBe("not_found");
      expect(verification.spanStart).toBeNull();
      expect(verification.spanEnd).toBeNull();
      expect(verification.canonicalTextHash).toBe(EMPTY_TEXT_HASH);
      expect(source).toEqual({ canonicalText: "", canonicalTextHash: EMPTY_TEXT_HASH, inputMode: "text" });
    }
    // The same answer the caller's own document gives a quote it doesn't contain.
    const absentInOwned = results[2].verification;
    const unusable = results[1].verification;
    expect([unusable.status, unusable.spanStart, unusable.spanEnd, unusable.quote, unusable.verifierVersion]).toEqual([
      absentInOwned.status,
      absentInOwned.spanStart,
      absentInOwned.spanEnd,
      absentInOwned.quote,
      absentInOwned.verifierVersion,
    ]);
  });

  it("the positive control: the foreign document's owner gets that very quote verified", async () => {
    const foreign = await readyDocument(t, guestB);
    const asOwner = await batch(guestB, [{ documentId: foreign.id, quote: SAMPLE_QUOTE }]);
    const asIntruder = await batch(guestA, [{ documentId: foreign.id, quote: SAMPLE_QUOTE }]);
    expect(asOwner.results[0].verification.status).toBe("verified");
    expect(asIntruder.results[0].verification.status).toBe("not_found");
  });

  it("another principal's document is read once and its quotes are matched only against empty text", async () => {
    const foreign = await readyDocument(t, guestB);
    const owned = await readyDocument(t, guestA);
    vi.clearAllMocks();

    await batch(guestA, [
      { documentId: foreign.id, quote: SAMPLE_QUOTE },
      { documentId: owned.id, quote: SAMPLE_QUOTE },
    ]);

    // That the foreign read never selects canonical_text is proven on the SQL in
    // documents.foreign-text.idor.test.ts; here, each id is read once.
    expect(vi.mocked(getDocument).mock.calls.map((call) => call[2])).toEqual([foreign.id, owned.id]);
    // Its quotes were only ever matched against the empty text.
    expect(vi.mocked(verifyMany).mock.calls.map((call) => call[1])).toEqual(["", owned.canonicalText]);
  });
});

describe("verifyBatch.run — order, repeats and chunking", () => {
  it("results are in request order across interleaved documents; each distinct id is read once", async () => {
    const own = await readyDocument(t, guestA);
    const foreign = await readyDocument(t, guestB);
    const missing = randomUUID();
    vi.clearAllMocks();

    const { results } = await batch(guestA, [
      { documentId: own.id, quote: SAMPLE_QUOTE },
      { documentId: foreign.id, quote: SAMPLE_QUOTE },
      { documentId: own.id, quote: ABSENT_QUOTE },
      { documentId: missing, quote: SAMPLE_QUOTE },
      { documentId: own.id, quote: SAMPLE_QUOTE },
    ]);

    expect(results.map((r) => [r.quote, r.verification.status])).toEqual([
      [SAMPLE_QUOTE, "verified"],
      [SAMPLE_QUOTE, "not_found"],
      [ABSENT_QUOTE, "not_found"],
      [SAMPLE_QUOTE, "not_found"],
      [SAMPLE_QUOTE, "verified"],
    ]);
    // A repeated (document, quote) pair gets the identical answer.
    expect(results[4].verification.spanStart).toBe(results[0].verification.spanStart);
    expect(results[4].verification.spanEnd).toBe(results[0].verification.spanEnd);
    expect(vi.mocked(getDocument).mock.calls.map((call) => call[2])).toEqual([own.id, foreign.id, missing]);
    expect(vi.mocked(verifyMany).mock.calls.map((call) => call[0])).toEqual([
      [SAMPLE_QUOTE, ABSENT_QUOTE, SAMPLE_QUOTE],
      [SAMPLE_QUOTE],
      [SAMPLE_QUOTE],
    ]);
  });

  it("the same id in another letter case is the same document, read as a second one, with the same answers", async () => {
    const own = await readyDocument(t, guestA);
    const { results } = await batch(guestA, [
      { documentId: own.id, quote: SAMPLE_QUOTE },
      { documentId: own.id.toUpperCase(), quote: SAMPLE_QUOTE },
    ]);
    expect(results.map((r) => r.verification.status)).toEqual(["verified", "verified"]);
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(2);
  });

  it("a full batch against one document is one verifyMany call, each result at its own position", async () => {
    const own = await readyDocument(t, guestA);
    const citations = Array.from({ length: MAX_BATCH_CITATIONS }, (_, i) => ({
      documentId: own.id,
      quote: i % 2 === 0 ? SAMPLE_QUOTE : `${ABSENT_QUOTE} ${i}`,
    }));
    vi.clearAllMocks();

    const { results } = await batch(guestA, citations);

    expect(MAX_BATCH_CITATIONS).toBe(MAX_QUOTES_PER_CALL);
    expect(vi.mocked(verifyMany).mock.calls.map((call) => call[0].length)).toEqual([MAX_BATCH_CITATIONS]);
    expect(results.map((r) => r.quote)).toEqual(citations.map((c) => c.quote));
    expect(results.map((r) => r.verification.quote)).toEqual(citations.map((c) => c.quote));
    expect(results.map((r) => r.verification.status)).toEqual(citations.map((_, i) => (i % 2 === 0 ? "verified" : "not_found")));
  });

  // verifyMany holds the event loop for its whole call; other requests on the instance must get a
  // turn between one document's call and the next. A setImmediate ticker counts turns: two calls
  // that see the same count ran back to back as one block. The DB reads between documents don't
  // provide the turn (in-process PGlite settles in microtasks; a malformed id makes no query).
  it("each document's verifyMany runs in its own turn of the event loop, never back to back with another", async () => {
    const own = await readyDocument(t, guestA);
    const actual = await vi.importActual<typeof import("@/server/deterministic/verify")>("@/server/deterministic/verify");
    let turns = 0;
    let ticking = true;
    const tick = () => {
      turns++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const turnAtEachCall: number[] = [];
    vi.mocked(verifyMany).mockImplementation((...args) => {
      turnAtEachCall.push(turns);
      return actual.verifyMany(...args);
    });

    try {
      await batch(
        guestA,
        [own.id, own.id.toUpperCase(), randomUUID(), "not-a-uuid", "also-not-a-uuid"].map((documentId) => ({ documentId, quote: SAMPLE_QUOTE })),
      );
    } finally {
      ticking = false;
      vi.mocked(verifyMany).mockImplementation(actual.verifyMany);
    }

    expect(turnAtEachCall).toHaveLength(5);
    for (let i = 1; i < turnAtEachCall.length; i++) {
      expect(turnAtEachCall[i], `verifyMany call ${i + 1} vs call ${i}`).toBeGreaterThan(turnAtEachCall[i - 1]);
    }
  });
});

describe("verifyBatch.run — caps are enforced before any read or verify()", () => {
  const oversized: { name: string; citations: (id: string) => CitationToVerify[] }[] = [
    {
      name: `${MAX_BATCH_CITATIONS + 1} citations`,
      citations: (id) => Array.from({ length: MAX_BATCH_CITATIONS + 1 }, () => ({ documentId: id, quote: SAMPLE_QUOTE })),
    },
    {
      name: `${MAX_BATCH_DOCUMENTS + 1} distinct documents`,
      citations: (id) => [
        { documentId: id, quote: SAMPLE_QUOTE },
        ...Array.from({ length: MAX_BATCH_DOCUMENTS }, () => ({ documentId: randomUUID(), quote: SAMPLE_QUOTE })),
      ],
    },
    {
      name: `a ${MAX_QUOTE_CHARS + 1}-char quote`,
      citations: (id) => [
        { documentId: id, quote: SAMPLE_QUOTE },
        { documentId: id, quote: "a".repeat(MAX_QUOTE_CHARS + 1) },
      ],
    },
  ];

  it.each(oversized)("$name: a typed VALIDATION_FAILED with zero verify() calls and zero document reads", async ({ citations }) => {
    const own = await readyDocument(t, guestA);
    vi.clearAllMocks();

    const error = await caught(batch(guestA, citations(own.id)));

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(callCounts()).toEqual({ verify: 0, verifyMany: 0, getDocument: 0 });
  });

  // Positive control: the spies are bound to the modules the service really calls, so the zeros
  // above are not the spies missing every call.
  it("at every cap exactly, the batch runs — and the spies see its reads and verifyMany calls", async () => {
    const own = await readyDocument(t, guestA);
    vi.clearAllMocks();

    const { results } = await batch(guestA, [
      ...Array.from({ length: MAX_BATCH_CITATIONS - MAX_BATCH_DOCUMENTS }, () => ({ documentId: own.id, quote: SAMPLE_QUOTE })),
      { documentId: own.id, quote: "a".repeat(MAX_QUOTE_CHARS) },
      ...Array.from({ length: MAX_BATCH_DOCUMENTS - 1 }, () => ({ documentId: randomUUID(), quote: SAMPLE_QUOTE })),
    ]);

    expect(results).toHaveLength(MAX_BATCH_CITATIONS);
    expect(results[0].verification.status).toBe("verified");
    expect(callCounts()).toEqual({ verify: 0, verifyMany: MAX_BATCH_DOCUMENTS, getDocument: MAX_BATCH_DOCUMENTS });
  });
});

describe("verifyBatch.run — latency floor", () => {
  it(`every successful call takes at least MIN_RESPONSE_MS (${MIN_RESPONSE_MS} ms), whatever its documents were`, async () => {
    const own = await readyDocument(t, guestA);
    for (const documentId of [own.id, randomUUID(), "not-a-uuid"]) {
      const started = performance.now();
      await batch(guestA, [{ documentId, quote: SAMPLE_QUOTE }]);
      // 1 ms of slack: timers and performance.now() round differently.
      expect(performance.now() - started).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 1);
    }
  });
});
