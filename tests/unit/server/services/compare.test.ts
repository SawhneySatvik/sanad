import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import { pendingDocument } from "@tests/support/data/documents";
import { segmentClauses } from "@/server/deterministic/segment";
import { MAX_QUOTE_CHARS } from "@/server/deterministic/verify";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { LLM_TIMEOUT_MS } from "@/server/llm/timeouts";
import { MAX_CHANGES, MAX_PROMPT_CLAUSE_CHARS } from "@/server/prompts/compare/compare";
import { compare, findCandidateChanges, get, NO_MODEL_USED } from "@/server/services/compare";
import {
  candidateIds,
  type CompareHarness,
  createCompareHarness,
  explainAll,
  guestA,
  LEASE_A,
  LEASE_B,
  LEASE_CHANGES,
  QUOTES,
  userA,
} from "@tests/support/services/compare";

function numbered(bodies: readonly string[]): string {
  return bodies.map((body, i) => `${i + 1}. ${body}`).join("\n");
}

async function caught(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("findCandidateChanges — clause alignment (table)", () => {
  const bodies = [
    "The Licensee shall pay a monthly fee of Rs. 32,000.",
    "The security deposit is Rs. 1,60,000.",
    "Either Party may terminate with one month's notice.",
    "The courts at Pune have exclusive jurisdiction.",
  ];

  it("identical documents have no changes", () => {
    expect(findCandidateChanges(numbered(bodies), numbered(bodies))).toEqual([]);
  });

  it("re-wrapped lines and extra spaces are not changes", () => {
    const rewrapped = numbered(bodies).replace("monthly fee of", "monthly\n   fee  of");
    expect(findCandidateChanges(numbered(bodies), rewrapped)).toEqual([]);
  });

  it("one edited clause is exactly one change, carrying each side's exact clause", () => {
    const edited = [...bodies];
    edited[2] = "Either Party may terminate with three months' notice.";
    const a = numbered(bodies);
    const b = numbered(edited);
    const changes = findCandidateChanges(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: "c1", changeType: "changed" });
    expect(changes[0].clauseA!.text).toBe(`3. ${bodies[2]}`);
    expect(changes[0].clauseB!.text).toBe(`3. ${edited[2]}`);
    expect(a.slice(changes[0].clauseA!.start, changes[0].clauseA!.end)).toBe(changes[0].clauseA!.text);
    expect(b.slice(changes[0].clauseB!.start, changes[0].clauseB!.end)).toBe(changes[0].clauseB!.text);
  });

  it("an inserted clause that renumbers everything after it is one added change", () => {
    const inserted = [...bodies.slice(0, 1), "A lock-in period of six months applies.", ...bodies.slice(1)];
    const changes = findCandidateChanges(numbered(bodies), numbered(inserted));
    expect(changes.map((c) => [c.changeType, c.clauseA?.text ?? null, c.clauseB?.text ?? null])).toEqual([
      ["added", null, "2. A lock-in period of six months applies."],
    ]);
  });

  it("a deleted clause that renumbers everything after it is one removed change", () => {
    const deleted = [...bodies.slice(0, 1), ...bodies.slice(2)];
    const changes = findCandidateChanges(numbered(bodies), numbered(deleted));
    expect(changes.map((c) => [c.changeType, c.clauseA?.text ?? null, c.clauseB?.text ?? null])).toEqual([
      ["removed", "2. The security deposit is Rs. 1,60,000.", null],
    ]);
  });

  it("an insert next to an edit pairs the edit by content, not by its shifted number", () => {
    const next = [bodies[0], "A lock-in period of six months applies.", "The security deposit is Rs. 2,00,000.", ...bodies.slice(2)];
    const changes = findCandidateChanges(numbered(bodies), numbered(next));
    expect(changes.map((c) => [c.changeType, c.clauseA?.text ?? null, c.clauseB?.text ?? null])).toEqual([
      ["changed", "2. The security deposit is Rs. 1,60,000.", "3. The security deposit is Rs. 2,00,000."],
      ["added", null, "2. A lock-in period of six months applies."],
    ]);
  });

  it("finds exactly the four changes injected into the lease fixture", () => {
    const changes = findCandidateChanges(LEASE_A, LEASE_B);
    expect(changes.map((c) => [c.id, c.changeType])).toEqual(LEASE_CHANGES.map((c) => [c.id, c.changeType]));
    for (const [i, expected] of LEASE_CHANGES.entries()) {
      const clause = changes[i].clauseA ?? changes[i].clauseB;
      expect(clause!.text.startsWith(`${expected.clause} `)).toBe(true);
    }
  });

  it(`more than MAX_CHANGES (${MAX_CHANGES}) changes is a typed VALIDATION_FAILED`, () => {
    const a = numbered(Array.from({ length: MAX_CHANGES + 1 }, (_, i) => `alpha clause number ${i} text`));
    const b = numbered(Array.from({ length: MAX_CHANGES + 1 }, (_, i) => `omega wording ${i} differs`));
    expect(() => findCandidateChanges(a, b)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    // Exactly MAX_CHANGES clauses edited in place is still accepted.
    const c = numbered(Array.from({ length: MAX_CHANGES }, (_, i) => `alpha clause number ${i} text`));
    const d = numbered(Array.from({ length: MAX_CHANGES }, (_, i) => `alpha clause number ${i} changed`));
    expect(findCandidateChanges(c, d)).toHaveLength(MAX_CHANGES);
  });

  it("bounds the alignment table: a long document edited at both ends aligns; a longer one is refused", () => {
    // Unnumbered paragraphs: segment.ts only reads 1-3 digit clause numbers.
    const paragraphs = (count: number) => Array.from({ length: count }, (_, i) => `paragraph body ${i}`);
    const editBothEnds = (bodies: string[]) => ["first paragraph rewritten", ...bodies.slice(1, -1), "last paragraph rewritten"];

    const long = paragraphs(1_900);
    expect(segmentClauses(long.join("\n\n"))).toHaveLength(1_900);
    const started = performance.now();
    expect(findCandidateChanges(long.join("\n\n"), editBothEnds(long).join("\n\n")).map((c) => c.changeType)).toEqual([
      "changed",
      "changed",
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);

    // 2,100 x 2,100 cells > MAX_ALIGN_CELLS.
    const longer = paragraphs(2_100);
    expect(segmentClauses(longer.join("\n\n"))).toHaveLength(2_100);
    expect(() => findCandidateChanges(longer.join("\n\n"), editBothEnds(longer).join("\n\n"))).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});

describe("findCandidateChanges — properties", () => {
  // Lowercase words only: a body can never start a clause marker ("2.", "(a)", "Clause ii").
  const WORDS = ["rent", "deposit", "notice", "tenant", "owner", "shall", "pay", "month", "days", "repair", "water", "keys"];
  const body = fc.array(fc.constantFrom(...WORDS), { minLength: 3, maxLength: 7 }).map((words) => words.join(" "));
  const document = fc.uniqueArray(body, { minLength: 2, maxLength: 12 });
  const withNewBody = document.chain((bodies) =>
    fc.record({
      bodies: fc.constant(bodies),
      at: fc.nat({ max: bodies.length - 1 }),
      fresh: body.filter((candidate) => !bodies.includes(candidate)),
    }),
  );

  function assertSegmentsInto(text: string, count: number) {
    expect(segmentClauses(text)).toHaveLength(count);
  }

  it("identical documents → zero changes", () => {
    fc.assert(
      fc.property(document, (bodies) => {
        assertSegmentsInto(numbered(bodies), bodies.length);
        expect(findCandidateChanges(numbered(bodies), numbered(bodies))).toEqual([]);
      }),
    );
  });

  it("one clause edited in place → exactly that change", () => {
    fc.assert(
      fc.property(withNewBody, ({ bodies, at, fresh }) => {
        const edited = bodies.map((b, i) => (i === at ? fresh : b));
        assertSegmentsInto(numbered(edited), bodies.length);
        const changes = findCandidateChanges(numbered(bodies), numbered(edited));
        expect(changes.map((c) => [c.changeType, c.clauseA?.text, c.clauseB?.text])).toEqual([
          ["changed", `${at + 1}. ${bodies[at]}`, `${at + 1}. ${fresh}`],
        ]);
      }),
    );
  });

  it("one clause inserted (everything after it renumbered) → exactly one added change", () => {
    fc.assert(
      fc.property(withNewBody, ({ bodies, at, fresh }) => {
        const inserted = [...bodies.slice(0, at), fresh, ...bodies.slice(at)];
        assertSegmentsInto(numbered(inserted), bodies.length + 1);
        const changes = findCandidateChanges(numbered(bodies), numbered(inserted));
        expect(changes.map((c) => [c.changeType, c.clauseA, c.clauseB?.text])).toEqual([["added", null, `${at + 1}. ${fresh}`]]);
      }),
    );
  });

  it("one clause deleted (everything after it renumbered) → exactly one removed change", () => {
    fc.assert(
      fc.property(withNewBody, ({ bodies, at }) => {
        const deleted = bodies.filter((_, i) => i !== at);
        const changes = findCandidateChanges(numbered(bodies), numbered(deleted));
        expect(changes.map((c) => [c.changeType, c.clauseA?.text, c.clauseB])).toEqual([["removed", `${at + 1}. ${bodies[at]}`, null]]);
      }),
    );
  });
});

describe("compare — full pipeline", () => {
  let h: CompareHarness;
  beforeEach(async () => {
    h = await createCompareHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("detects every injected change from ONE LLM call, persists them, and returns fresh verifications", async () => {
    // defaultResponse, not a one-entry queue: a second call would be answered, so only the
    // call-count assertion can catch it.
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_B);

    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

    expect(llm.callCount).toBe(1);
    expect(result.comparison.modelUsed).toBe("fake-model");
    expect(result.comparison).toMatchObject({ documentAId: a.id, documentBId: b.id, ownerGuestSessionId: "repo-guest-a" });
    expect(result.changes.map((c) => c.changeType)).toEqual(LEASE_CHANGES.map((c) => c.changeType));
    expect(result.changes.map((c) => c.explanation)).toEqual(LEASE_CHANGES.map((c) => `Model explanation of ${c.id}.`));
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 4 });

    // With no model quotes, each side quotes its whole clause — verified, and sliced from its own document.
    for (const change of result.changes) {
      for (const [quote, verification, text] of [
        [change.quoteA, change.verificationA, result.documentA.canonicalText!],
        [change.quoteB, change.verificationB, result.documentB.canonicalText!],
      ] as const) {
        if (quote === null) {
          expect(verification).toBeNull();
          continue;
        }
        expect(verification!.status).toBe("verified");
        expect(text.slice(verification!.spanStart!, verification!.spanEnd!)).toBe(quote);
      }
    }
    expect([result.changes[2].quoteA, result.changes[2].quoteB]).toEqual([expect.stringMatching(/^3\.2 /), null]);
    expect([result.changes[3].quoteA, result.changes[3].quoteB]).toEqual([null, expect.stringMatching(/^4\.3 /)]);

    const reread = await get(h.deps(new FakeLlmClient()), guestA, result.comparison.id);
    expect(reread.changes).toEqual(result.changes);
  });

  it("sends each candidate's clauses as fenced data, and only the candidates", async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_B);
    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

    const call = llm.calls[0];
    expect(call.documents).toBeUndefined();
    expect(candidateIds(call.userPrompt)).toEqual(["c1", "c2", "c3", "c4"]);
    const boundary = /<<<(CHANGES-[0-9a-f]{16}) BEGIN>>>/.exec(call.userPrompt)![1];
    expect(call.userPrompt).toContain(`<<<${boundary} c1 A>>>\n${result.changes[0].quoteA}\n<<<${boundary} c1 B>>>\n${result.changes[0].quoteB}\n`);
    // An unchanged clause is never sent.
    expect(call.userPrompt).not.toContain("5.1 This Agreement shall be governed");
  });

  it("keeps a model quote found inside its own clause, and quotes the clause instead of one that is not", async () => {
    const llm = new FakeLlmClient({
      defaultResponse: explainAll({
        c1: { quoteA: QUOTES.feeA, quoteB: QUOTES.feeB },
        c2: { quoteA: QUOTES.elsewhere, quoteB: QUOTES.fabricated },
        // quoteA on an added clause has no side to belong to.
        c4: { quoteA: QUOTES.feeA, quoteB: QUOTES.lateFeeB },
      }),
    });
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_B);
    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });
    const [fee, refund, , lateFee] = result.changes;

    expect([fee.quoteA, fee.quoteB]).toEqual([QUOTES.feeA, QUOTES.feeB]);
    expect([fee.verificationA!.status, fee.verificationB!.status]).toEqual(["verified", "verified"]);
    expect(result.documentB.canonicalText!.slice(fee.verificationB!.spanStart!, fee.verificationB!.spanEnd!)).toBe(QUOTES.feeB);

    expect(refund.quoteA).toMatch(/^2\.2 The Licensee shall pay/);
    expect(refund.quoteB).toMatch(/^2\.2 The Licensee shall pay/);
    expect([refund.verificationA!.status, refund.verificationB!.status]).toEqual(["verified", "verified"]);

    expect([lateFee.quoteA, lateFee.quoteB]).toEqual([null, QUOTES.lateFeeB]);
    expect(result.modelQuotes).toEqual({ kept: 3, replaced: 2 });
  });

  it("drops answers for ids it never supplied; a candidate the model skipped keeps a plain explanation", async () => {
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            changes: [
              { id: "c9", explanation: "Invented change.", quoteA: QUOTES.fabricated, quoteB: null },
              { id: "c1", explanation: "The monthly fee rises.", quoteA: null, quoteB: null },
              { id: "c1", explanation: "A second answer for c1.", quoteA: null, quoteB: null },
              { id: "c3", explanation: "   ", quoteA: null, quoteB: null },
            ],
          },
        },
      ],
    });
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_B);
    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

    expect(result.changes.map((c) => c.explanation)).toEqual([
      "The monthly fee rises.",
      "The wording of this clause differs between the two documents.",
      "This clause appears only in the first document.",
      "This clause appears only in the second document.",
    ]);
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 4 });
  });

  it("a response far over the schema's uncapped range is used, not failed — the first answer per candidate id wins", async () => {
    const unknown = Array.from({ length: 2 * MAX_CHANGES + 20 }, (_, i) => ({ id: `u${i}`, explanation: "Unknown id.", quoteA: null, quoteB: null }));
    const answer = (prefix: string) =>
      LEASE_CHANGES.map((change) => ({ id: change.id, explanation: `${prefix} ${change.id}.`, quoteA: null, quoteB: null }));
    // One queued response: a schema rejection would spend the repair retry, find the queue empty and throw.
    const llm = new FakeLlmClient({ responses: [{ data: { changes: [...unknown, ...answer("First answer for"), ...answer("Repeat for")] } }] });
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_B);

    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

    expect(llm.callCount).toBe(1);
    expect(llm.calls[0].timeoutMs).toBe(LLM_TIMEOUT_MS.compare);
    expect(result.changes.map((c) => c.explanation)).toEqual(LEASE_CHANGES.map((change) => `First answer for ${change.id}.`));
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 4 });
  });

  it("identical documents make a comparison with no changes and no LLM call", async () => {
    const llm = new FakeLlmClient();
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_A);
    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });
    expect(llm.callCount).toBe(0);
    expect(result.comparison.modelUsed).toBe(NO_MODEL_USED);
    expect(NO_MODEL_USED).toBe("none");
    expect(result.changes).toEqual([]);
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 0 });
  });

  it("documents too different to compare are VALIDATION_FAILED before any LLM call or write", async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(guestA, numbered(Array.from({ length: MAX_CHANGES + 1 }, (_, i) => `alpha clause ${i} text`)));
    const b = await h.document(guestA, numbered(Array.from({ length: MAX_CHANGES + 1 }, (_, i) => `omega wording ${i} here`)));
    const error = await caught(compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it("comparing a document with itself is VALIDATION_FAILED before any read, LLM call or write", async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(guestA, LEASE_A);
    for (const [first, second] of [
      [a.id, a.id],
      [a.id, a.id.toUpperCase()],
    ]) {
      const error = await caught(compare(h.deps(llm), guestA, { documentAId: first, documentBId: second }));
      expect([error.code, error.message]).toEqual(["VALIDATION_FAILED", "Choose two different documents to compare."]);
    }
    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });

    // Positive control: a second document with the very same text is a real comparison.
    const copy = await h.document(guestA, LEASE_A);
    expect((await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: copy.id })).changes).toEqual([]);
  });

  it("a document that is not ready is INVALID_DOCUMENT, with no LLM call", async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(guestA, LEASE_A);
    const pending = await pendingDocument(h.t, guestA);
    const error = await caught(compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: pending.id }));
    expect(error.code).toBe("INVALID_DOCUMENT");
    expect(llm.callCount).toBe(0);
  });

  it("caps a huge clause in the prompt, and quotes it within verify()'s quote limit", async () => {
    const huge = `2. The Licensee shall ${"keep the premises clean and ".repeat(400)}at all times.`;
    expect(huge.length).toBeGreaterThan(MAX_QUOTE_CHARS);
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(userA, `1. Rent is Rs. 32,000.\n${huge}`);
    const b = await h.document(userA, "1. Rent is Rs. 32,000.");
    const result = await compare(h.deps(llm), userA, { documentAId: a.id, documentBId: b.id });

    expect(llm.calls[0].userPrompt.length).toBeLessThan(MAX_PROMPT_CLAUSE_CHARS + 1_000);
    const [removed] = result.changes;
    expect(removed.changeType).toBe("removed");
    expect(removed.quoteA!.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(huge.startsWith(removed.quoteA!)).toBe(true);
    expect(removed.verificationA!.status).toBe("verified");
  });

  it("holds no transaction open across the LLM call", async () => {
    // The probe itself can fail: it reads true inside a real drizzle transaction.
    await h.t.db.transaction(async () => {
      expect(h.t.client.isInTransaction()).toBe(true);
    });
    expect(h.t.client.isInTransaction()).toBe(false);

    const seen: boolean[] = [];
    const answer = explainAll();
    const llm = new FakeLlmClient({
      responses: [
        (ctx) => {
          seen.push(h.t.client.isInTransaction());
          return answer(ctx);
        },
      ],
    });
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_B);
    await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });
    expect(seen).toEqual([false]);
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 4 });
  });
});
