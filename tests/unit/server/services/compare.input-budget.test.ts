import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_INPUT_BUDGET_CHARS } from "@/server/llm/timeouts";
import { MAX_CHANGES, MAX_PROMPT_CLAUSE_CHARS } from "@/server/prompts/compare/compare";
import { compare, findCandidateChanges } from "@/server/services/compare";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { type CompareHarness, createCompareHarness, explainAll, guestA } from "@tests/support/services/compare";

// Each clause is already cut to MAX_PROMPT_CLAUSE_CHARS in the prompt, so only many long changed
// clauses can take Compare's prompt over its input budget: then the comparison is refused before
// the model call, with a typed error, and nothing is persisted.

let h: CompareHarness;
beforeEach(async () => {
  h = await createCompareHarness();
});
afterEach(async () => {
  await h.close();
});

// `count` clauses of words unique to each clause, every one longer than the prompt's per-clause cut;
// side B changes one word per clause, so every clause is a "changed" candidate.
function documents(count: number): { a: string; b: string } {
  const clause = (i: number, side: string) =>
    `${i + 1}. ${Array.from({ length: 200 }, (_, k) => (k === 100 ? `${side}${i}` : `w${i}x${k}`)).join(" ")}`;
  const a = Array.from({ length: count }, (_, i) => clause(i, "alpha")).join("\n");
  const b = Array.from({ length: count }, (_, i) => clause(i, "omega")).join("\n");
  return { a, b };
}

describe("compare — Compare's model input budget", () => {
  it(`${MAX_CHANGES} long changed clauses: VALIDATION_FAILED with zero model calls and no comparison`, async () => {
    const { a, b } = documents(MAX_CHANGES);
    expect(findCandidateChanges(a, b).map((change) => change.changeType)).toEqual(Array(MAX_CHANGES).fill("changed"));
    expect(a.split("\n").every((line) => line.length > MAX_PROMPT_CLAUSE_CHARS)).toBe(true);
    const documentA = await h.document(guestA, a);
    const documentB = await h.document(guestA, b);
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });

    await expect(compare(h.deps(llm), guestA, { documentAId: documentA.id, documentBId: documentB.id })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toEqual({ comparisons: 0, changes: 0 });
  });

  it("positive control: fewer long changed clauses fit, and are explained in one model call", async () => {
    const { a, b } = documents(40);
    const documentA = await h.document(guestA, a);
    const documentB = await h.document(guestA, b);
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });

    const result = await compare(h.deps(llm), guestA, { documentAId: documentA.id, documentBId: documentB.id });

    expect(result.changes).toHaveLength(40);
    expect(llm.callCount).toBe(1);
    expect(llm.calls[0].userPrompt.length).toBeLessThanOrEqual(MODEL_INPUT_BUDGET_CHARS.compare);
  });
});
