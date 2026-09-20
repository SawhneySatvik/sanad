import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { generate } from "@/server/services/prepare";
import { analyzeLease, complete, createHarness, guestA, type Harness } from "@tests/support/services/prepare";

// The alias scrub runs on model text, so its input is whatever a model or gateway emits. Each case
// is timed against a baseline generate() call with a short question, taking the fastest of several
// runs, so PGlite reads and machine load cancel out. Before whitespace was collapsed first, a 40k
// run took 2.2 s here; before the sentence-start check looked only at the characters just before
// each alias, 16k aliases took 2.1 s.
const RUNS = 3;

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

function prepareOutput(question: string) {
  return { lawyerQuestions: [{ question, whyItMatters: "It sets the deposit terms.", findingIds: ["F1"] }], checklist: [] };
}

async function fastestMs(documentId: string, question: string): Promise<{ ms: number; question: string }> {
  let ms = Infinity;
  let scrubbed = "";
  for (let run = 0; run < RUNS; run++) {
    const llm = new FakeLlmClient({ defaultResponse: { data: prepareOutput(question) } });
    const started = performance.now();
    const result = complete(await generate(h.deps(llm), guestA, documentId));
    ms = Math.min(ms, performance.now() - started);
    scrubbed = result.lawyerQuestions[0].question;
  }
  return { ms, question: scrubbed };
}

describe("generate — alias scrub cost on adversarial model text", () => {
  it("a 40,000-character whitespace run costs under 50 ms more than a short question, and collapses to one space", async () => {
    const { document } = await analyzeLease(h);
    const baseline = await fastestMs(document.id, "What is the deposit?");
    const run = "x" + " ".repeat(40_000) + "y";
    expect(run.length).toBe(40_002);

    const timed = await fastestMs(document.id, run);

    expect(timed.question).toBe("x y");
    expect(timed.ms - baseline.ms).toBeLessThan(50);
  });

  it("16,000 offered aliases cost under 250 ms more than a short question, and every one is replaced", async () => {
    const { document } = await analyzeLease(h);
    const baseline = await fastestMs(document.id, "What is the deposit?");
    const dense = "Ask about F1 now. ".repeat(16_000).trim();

    const timed = await fastestMs(document.id, dense);

    expect(timed.question).not.toMatch(/\bF1\b/);
    expect(timed.question.startsWith("Ask about the linked finding now. Ask about the linked finding now.")).toBe(true);
    expect(timed.ms - baseline.ms).toBeLessThan(250);
  });

  it("an alias that starts a sentence is still capitalized after the whitespace before it is collapsed", async () => {
    const { document } = await analyzeLease(h);

    const timed = await fastestMs(document.id, "Check the deposit.\n\n   F1 sets the refund date.");

    expect(timed.question).toBe("Check the deposit. The linked finding sets the refund date.");
  });
});
