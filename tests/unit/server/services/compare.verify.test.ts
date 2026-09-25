// One Guarantee tests for the Compare surface: model payload, model fallback, errors, span binding,
// persistence, native documents (Compare has no streaming/orchestrator/general-mode/cache path). The
// write-path binding (A/B swap, forged results) is pinned in data/comparisons.verify.test.ts.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { AppError } from "@/server/core/errors";
import type { InputMode } from "@/server/core/types";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { FallbackLlmClient } from "@/server/llm/fallback";
import { assertSafeResponseSchema } from "@/server/llm/schema-guard";
import { compare, get, type ComparisonResult } from "@/server/services/compare";
import { comparisonView } from "@/server/http/views/comparison-view";
import {
  candidateIds,
  type CompareHarness,
  createCompareHarness,
  explainAll,
  guestA,
  LEASE_A,
  LEASE_B,
  QUOTES,
} from "@tests/support/services/compare";

let h: CompareHarness;
beforeEach(async () => {
  h = await createCompareHarness();
});
afterEach(async () => {
  await h.close();
});

type InputModes = { a: InputMode; b: InputMode };

async function compareLease(llm: FakeLlmClient | FallbackLlmClient, modes: InputModes = { a: "text", b: "text" }) {
  const a = await h.document(guestA, LEASE_A, modes.a);
  const b = await h.document(guestA, LEASE_B, modes.b);
  return compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });
}

async function storedChanges() {
  return h.t.db.select().from(schema.comparisonChanges).orderBy(schema.comparisonChanges.id);
}

it("a fallback explanation is templated per change even when the comparison used a model", async () => {
  const llm = new FakeLlmClient({
    responses: [{ data: { changes: [
      { id: "c1", explanation: "The monthly fee rises.", quoteA: null, quoteB: null },
      { id: "c2", explanation: "  ", quoteA: null, quoteB: null },
    ] } }],
  });
  const created = await compareLease(llm);
  const view = comparisonView(created);
  expect(view.changes[0].explanationProvenance).toBe("ai_generated");
  expect(view.changes[1].explanationProvenance).toBe("templated");
  const reloaded = comparisonView(await get(h.deps(llm), guestA, created.comparison.id));
  expect(reloaded.changes.map((change) => change.explanationProvenance).slice(0, 2)).toEqual(["ai_generated", "templated"]);
});

// The messages of a rejection and its cause chain (drizzle wraps the Postgres error).
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(" | ");
  }
  throw new Error("expected a rejection");
}

function statuses(result: ComparisonResult) {
  return result.changes.map((change) => [change.verificationA?.status ?? null, change.verificationB?.status ?? null]);
}

describe("the model cannot self-certify (no status/span in the response schema)", () => {
  function selfCertifying(quoteA: string, quoteB: string) {
    return new FakeLlmClient({
      defaultResponse: ({ input }) => ({
        data: {
          verified: true,
          changes: candidateIds(input.userPrompt).map((id) => ({
            id,
            explanation: "Self-certified.",
            quoteA: id === "c1" ? quoteA : null,
            quoteB: id === "c1" ? quoteB : null,
            status: "verified",
            statusA: "verified",
            verificationStatus: "verified",
            quote_span_start: 0,
            quote_span_end: 12,
          })),
        },
      }),
    });
  }

  it("negative: a fabricated quote the model marks verified, with its own spans, is never stored or shown", async () => {
    const llm = selfCertifying(QUOTES.fabricated, QUOTES.fabricated);
    const result = await compareLease(llm);
    const [fee] = result.changes;

    expect(fee.quoteA).not.toBe(QUOTES.fabricated);
    expect(fee.quoteB).not.toBe(QUOTES.fabricated);
    expect(result.modelQuotes).toEqual({ kept: 0, replaced: 2 });
    const stored = await storedChanges();
    expect(JSON.stringify(stored)).not.toContain(QUOTES.fabricated);
    // The status shown is verify()'s over the clause quoted instead, with verify()'s span — not 0..12.
    expect(fee.verificationA!.spanStart).not.toBe(0);
    expect(result.documentA.canonicalText!.slice(fee.verificationA!.spanStart!, fee.verificationA!.spanEnd!)).toBe(fee.quoteA);
    // And the schema the model was given carries no status field.
    expect(() => assertSafeResponseSchema(llm.calls[0].schema)).not.toThrow();
  });

  it("positive: a real quote is verified — by verify(), with server spans, not the model's 0..12", async () => {
    const result = await compareLease(selfCertifying(QUOTES.feeA, QUOTES.feeB));
    const [fee] = result.changes;
    expect([fee.quoteA, fee.quoteB]).toEqual([QUOTES.feeA, QUOTES.feeB]);
    expect([fee.verificationA!.status, fee.verificationB!.status]).toEqual(["verified", "verified"]);
    expect(fee.verificationA!.spanStart).not.toBe(0);
    expect(result.documentA.canonicalText!.slice(fee.verificationA!.spanStart!, fee.verificationA!.spanEnd!)).toBe(QUOTES.feeA);
  });
});

describe("model fallback runs the same verify() path and surfaces the model", () => {
  function fallbackClient(quotes: Parameters<typeof explainAll>[0]) {
    const primary = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "primary down") }] });
    const secondary = new FakeLlmClient({ modelUsed: "fake-gemma", defaultResponse: explainAll(quotes) });
    return new FallbackLlmClient(primary, secondary);
  }

  it("positive: a real quote from the fallback model is verified, and the fallback model is reported", async () => {
    const result = await compareLease(fallbackClient({ c1: { quoteA: QUOTES.feeA, quoteB: QUOTES.feeB } }));
    expect(result.comparison.modelUsed).toBe("fake-gemma");
    expect([result.changes[0].verificationA!.status, result.changes[0].verificationB!.status]).toEqual(["verified", "verified"]);
    expect(result.changes[0].quoteB).toBe(QUOTES.feeB);
  });

  it("negative: a fabricated quote from the fallback model is discarded, never shown", async () => {
    const result = await compareLease(fallbackClient({ c1: { quoteA: QUOTES.fabricated, quoteB: QUOTES.fabricated } }));
    expect(result.comparison.modelUsed).toBe("fake-gemma");
    expect(result.changes[0].quoteA).not.toBe(QUOTES.fabricated);
    expect(result.modelQuotes.replaced).toBe(2);
  });

  it("after a reload, the comparison still names the fallback model — persisted, not just returned", async () => {
    const created = await compareLease(fallbackClient({}));
    const [row] = await h.t.db.select().from(schema.comparisons);
    expect(row.modelUsed).toBe("fake-gemma");

    const reloaded = await get(h.deps(new FakeLlmClient()), guestA, created.comparison.id);
    expect(reloaded.comparison.modelUsed).toBe("fake-gemma");
    expect(reloaded.comparison.modelUsed).not.toBe("fake-model");
  });
});

describe("errors return no content and persist nothing", () => {
  it("negative: a provider failure is a typed error with no comparison and no changes", async () => {
    const llm = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "down") }] });
    await expect(compareLease(llm)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it("negative: malformed model output (twice, past the repair retry) is SCHEMA_FAILED with nothing persisted", async () => {
    const llm = new FakeLlmClient({ responses: [{ rawText: "not json" }, { rawText: '{"changes":"nope"}' }] });
    await expect(compareLease(llm)).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it("negative: a failure inside the persist transaction (last insert) rolls back the comparison row", async () => {
    await h.t.client.exec("ALTER TABLE comparison_changes ADD CONSTRAINT test_reject_every_row CHECK (false)");
    expect(await rejectionText(compareLease(new FakeLlmClient({ defaultResponse: explainAll() })))).toMatch(/test_reject_every_row/);
    expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it("positive: once the failure clears, the same documents compare normally", async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(guestA, LEASE_A);
    const b = await h.document(guestA, LEASE_B);
    await h.t.client.exec("ALTER TABLE comparison_changes ADD CONSTRAINT test_reject_every_row CHECK (false)");
    await expect(compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id })).rejects.toThrow();
    await h.t.client.exec("ALTER TABLE comparison_changes DROP CONSTRAINT test_reject_every_row");

    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });
    expect(statuses(result)).toEqual([
      ["verified", "verified"],
      ["verified", "verified"],
      ["verified", null],
      [null, "verified"],
    ]);
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 4 });
  });
});

describe("each side's span indexes its OWN document's canonical_text", () => {
  it("positive: side A slices document A to quote A and side B slices document B to quote B (an A/B swap would not)", async () => {
    const result = await compareLease(new FakeLlmClient({ defaultResponse: explainAll({ c1: { quoteA: QUOTES.feeA, quoteB: QUOTES.feeB } }) }));
    const textA = result.documentA.canonicalText!;
    const textB = result.documentB.canonicalText!;
    // The two quotes exist only on their own side, so a swapped binding cannot slice to them.
    expect(textB).not.toContain(QUOTES.feeA);
    expect(textA).not.toContain(QUOTES.feeB);
    for (const change of result.changes) {
      if (change.verificationA) expect(textA.slice(change.verificationA.spanStart!, change.verificationA.spanEnd!)).toBe(change.quoteA);
      if (change.verificationB) expect(textB.slice(change.verificationB.spanStart!, change.verificationB.spanEnd!)).toBe(change.quoteB);
      // Each present side is bound to its own document row's hash; an absent side has no result at all.
      if (change.changeType === "added") expect(change.verificationA).toBeNull();
      else expect(change.verificationA!.canonicalTextHash).toBe(result.documentA.canonicalTextHash);
      if (change.changeType === "removed") expect(change.verificationB).toBeNull();
      else expect(change.verificationB!.canonicalTextHash).toBe(result.documentB.canonicalTextHash);
    }
  });

  it("negative: the side a clause is absent from has no quote, no status and no span to highlight", async () => {
    const result = await compareLease(new FakeLlmClient({ defaultResponse: explainAll({ c3: { quoteB: QUOTES.lateFeeB }, c4: { quoteA: QUOTES.feeA } }) }));
    const removed = result.changes.find((change) => change.changeType === "removed")!;
    const added = result.changes.find((change) => change.changeType === "added")!;
    expect([removed.quoteB, removed.verificationB]).toEqual([null, null]);
    expect([added.quoteA, added.verificationA]).toEqual([null, null]);
  });
});

describe("every span shown lands on its own clause, never on another copy of the text", () => {
  const REPEATED = "(a) The Licensee shall pay the electricity charges.";
  const PROBE_A = [
    "1. UTILITIES",
    REPEATED,
    "(b) The Licensor shall pay the property tax.",
    "2. MAINTENANCE",
    REPEATED,
    "(b) The Licensee shall keep the premises clean.",
  ].join("\n");
  // The second copy of the repeated clause is dropped.
  const PROBE_B = PROBE_A.replace(`MAINTENANCE\n${REPEATED}\n`, "MAINTENANCE\n");

  async function compareTexts(textA: string, textB: string) {
    const a = await h.document(guestA, textA);
    const b = await h.document(guestA, textB);
    return compare(h.deps(new FakeLlmClient({ defaultResponse: explainAll() })), guestA, { documentAId: a.id, documentBId: b.id });
  }

  it("positive: a removed clause repeated word for word earlier is highlighted at its own (second) copy", async () => {
    const result = await compareTexts(PROBE_A, PROBE_B);
    const text = result.documentA.canonicalText!;
    const first = text.indexOf(REPEATED);
    const second = text.indexOf(REPEATED, first + 1);
    expect(second).toBeGreaterThan(first);

    expect(result.changes.map((change) => change.changeType)).toEqual(["removed"]);
    const side = result.changes[0].verificationA!;
    expect(side.status).toBe("verified");
    // Ends exactly at the second copy's end and starts after the first copy: the borrowed words of
    // context ("MAINTENANCE") make it unique to this place.
    expect(side.spanEnd).toBe(second + REPEATED.length);
    expect(side.spanStart).toBeGreaterThanOrEqual(first + REPEATED.length);
    expect(text.slice(side.spanStart!, side.spanEnd!)).toBe(result.changes[0].quoteA);
    expect(result.changes[0].quoteA!.endsWith(REPEATED)).toBe(true);
  });

  it("negative: on reload, a stored quote whose fresh span lands on the other copy is withheld, not shown there", async () => {
    const created = await compareTexts(PROBE_A, PROBE_B);
    const [row] = await storedChanges();
    // As if a verifier change now matched only the bare clause text: its first occurrence is the
    // surviving copy, outside this change's clause.
    await h.t.db.update(schema.comparisonChanges).set({ quoteTextA: REPEATED }).where(eq(schema.comparisonChanges.id, row.id));

    const reloaded = await get(h.deps(new FakeLlmClient()), guestA, created.comparison.id);
    expect([reloaded.changes[0].quoteA, reloaded.changes[0].verificationA]).toEqual([null, null]);
  });

  it("negative: a clause that cannot be told apart from an identical passage gets no quote and no status", async () => {
    const filler = Array.from({ length: 40 }, (_, i) => `term${i}`).join(" ");
    const paragraph = `(a) ${filler}.`;
    const clause = "(b) The Licensee shall pay the electricity charges.";
    // The repeated clause and paragraph have the same 32+ words of context on both sides.
    const result = await compareTexts(
      [paragraph, clause, paragraph, clause, paragraph].join("\n"),
      [paragraph, clause, paragraph].join("\n"),
    );
    expect(result.changes.map((change) => [change.changeType, change.quoteA, change.verificationA])).toEqual([
      ["removed", null, null],
      ["removed", null, null],
    ]);
    const stored = await storedChanges();
    expect(stored.map((row) => [row.quoteTextA, row.verificationStatusA, row.docASpanStart])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("negative: if the stored changes no longer match the clauses rebuilt from the texts, every quote is withheld", async () => {
    const created = await compareLease(new FakeLlmClient({ defaultResponse: explainAll() }));
    expect(created.changes.every((change) => change.verificationA !== null || change.verificationB !== null)).toBe(true);
    const [first] = await storedChanges();
    await h.t.db.update(schema.comparisonChanges).set({ changeType: "removed" }).where(eq(schema.comparisonChanges.id, first.id));

    const reloaded = await get(h.deps(new FakeLlmClient()), guestA, created.comparison.id);
    expect(reloaded.changes).toHaveLength(4);
    for (const change of reloaded.changes) {
      expect([change.quoteA, change.verificationA, change.quoteB, change.verificationB]).toEqual([null, null, null, null]);
    }
  });
});

describe("stored statuses are audit only; get() re-verifies each side", () => {
  it("negative: a stored side tampered to a fabricated quote marked 'verified' is returned not_found", async () => {
    const created = await compareLease(new FakeLlmClient({ defaultResponse: explainAll() }));
    const [first] = await storedChanges();
    await h.t.db
      .update(schema.comparisonChanges)
      .set({ quoteTextA: QUOTES.fabricated, verificationStatusA: "verified", docASpanStart: 0, docASpanEnd: 20 })
      .where(eq(schema.comparisonChanges.id, first.id));
    expect((await storedChanges())[0].verificationStatusA).toBe("verified");

    const result = await get(h.deps(new FakeLlmClient()), guestA, created.comparison.id);
    const tampered = result.changes[0].verificationA!;
    expect([tampered.status, tampered.spanStart, tampered.spanEnd]).toEqual(["not_found", null, null]);
    expect(result.changes[0].verificationB!.status).toBe("verified");
  });

  it("positive: a real quote tampered to not_found with wrong spans is returned verified with its true span", async () => {
    const created = await compareLease(new FakeLlmClient({ defaultResponse: explainAll({ c1: { quoteA: QUOTES.feeA, quoteB: QUOTES.feeB } }) }));
    const truth = created.changes[0].verificationB!;
    const [first] = await storedChanges();
    await h.t.db
      .update(schema.comparisonChanges)
      .set({ verificationStatusB: "not_found", docBSpanStart: null, docBSpanEnd: null, docASpanStart: 1, docASpanEnd: 2 })
      .where(eq(schema.comparisonChanges.id, first.id));

    const result = await get(h.deps(new FakeLlmClient()), guestA, created.comparison.id);
    const fee = result.changes[0];
    expect([fee.verificationB!.status, fee.verificationB!.spanStart, fee.verificationB!.spanEnd]).toEqual(["verified", truth.spanStart, truth.spanEnd]);
    expect(result.documentA.canonicalText!.slice(fee.verificationA!.spanStart!, fee.verificationA!.spanEnd!)).toBe(QUOTES.feeA);
  });
});

// Which sides each LEASE_A → LEASE_B change has a clause on: two changed, one removed, one added.
const LEASE_SIDES = [
  [true, true],
  [true, true],
  [true, false],
  [false, true],
] as const;

describe.each<["A" | "B"]>([["A"], ["B"]])("a native_document side can never be verified (native on side %s)", (nativeSide) => {
  const modes: InputModes = nativeSide === "A" ? { a: "native_document", b: "text" } : { a: "text", b: "native_document" };
  const statusOn = (side: "A" | "B") => (side === nativeSide ? "approximate" : "verified");
  const expected = LEASE_SIDES.map(([hasA, hasB]) => [hasA ? statusOn("A") : null, hasB ? statusOn("B") : null]);

  it("negative: every quote on the native side is approximate at most — stored and returned — while the text side verifies", async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll({ c1: { quoteA: QUOTES.feeA, quoteB: QUOTES.feeB } }) });
    const result = await compareLease(llm, modes);

    expect([result.documentA.inputMode, result.documentB.inputMode]).toEqual([modes.a, modes.b]);
    expect(statuses(result)).toEqual(expected);
    // The model quote on the native side is still kept (found inside its clause), capped all the same.
    expect([result.changes[0].quoteA, result.changes[0].quoteB]).toEqual([QUOTES.feeA, QUOTES.feeB]);
    const stored = await storedChanges();
    expect(stored.map((row) => [row.verificationStatusA, row.verificationStatusB])).toEqual(expected);

    // The persistence backstop refuses a verified native side outright…
    const forced = h.t.db
      .update(schema.comparisonChanges)
      .set(nativeSide === "A" ? { verificationStatusA: "verified" } : { verificationStatusB: "verified" })
      .where(eq(schema.comparisonChanges.id, stored[0].id))
      .then(() => undefined);
    expect(await rejectionText(forced)).toMatch(new RegExp(`side ${nativeSide} cannot be verified`));
    // …and a read still re-verifies to approximate.
    const reread = await get(h.deps(new FakeLlmClient()), guestA, result.comparison.id);
    expect(statuses(reread)).toEqual(expected);
  });
});

describe("positive control", () => {
  it("positive control: the same documents, both text, are verified on both sides", async () => {
    const result = await compareLease(new FakeLlmClient({ defaultResponse: explainAll({ c1: { quoteA: QUOTES.feeA, quoteB: QUOTES.feeB } }) }));
    expect(result.documentB.inputMode).toBe("text");
    expect(result.changes[0].verificationB!.status).toBe("verified");
  });
});
