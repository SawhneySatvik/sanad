import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_INPUT_BUDGET_CHARS } from "@/server/llm/timeouts";
import { generate } from "@/server/services/prepare";
import { analyze } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { complete, createHarness, guestA, type Harness, lensExplanationsFor, MIME } from "@tests/support/services/prepare";

// Prepare sends findings, not the document. A short document whose analysis quotes one long
// passage many times still takes the prompt over Prepare's input budget: then generate() refuses
// before its model call, with a typed error.

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

// 3,600 characters of plain words, unchanged by extraction, so a quote of it verifies.
const PASSAGE = Array.from({ length: 450 }, (_, k) => `word${k % 97}`).join(" ").slice(0, 3_600).trim();
const DOCUMENT = `Members water the raised beds on their assigned mornings.\n\n${PASSAGE}\n\nThe garden gate is locked at dusk.`;

async function analyzedWith(findingCount: number): Promise<string> {
  const findings = Array.from({ length: findingCount }, (_, i) => ({
    category: "obligation",
    quote: PASSAGE,
    lensExplanations: lensExplanationsFor("generic", `Reading ${i} of the same passage`),
  }));
  const llm = new FakeLlmClient({ responses: [{ data: { findings } }] });
  const input = await h.uploadBytes(guestA, "garden.txt", MIME.txt, new TextEncoder().encode(DOCUMENT));
  const analyzed = await analyze(h.deps(llm), guestA, input);
  expect(analyzed.findings.filter((finding) => finding.verification?.status === "verified")).toHaveLength(findingCount);
  return analyzed.document.id;
}

const prepareOutput = { lawyerQuestions: [{ question: "What does this passage require?", whyItMatters: "It binds you.", findingIds: ["F1"] }], checklist: [] };

describe("generate — Prepare's model input budget", () => {
  it("findings over the budget: INVALID_DOCUMENT with zero model calls", async () => {
    const documentId = await analyzedWith(40);
    const llm = new FakeLlmClient({ defaultResponse: { data: prepareOutput } });

    await expect(generate(h.deps(llm), guestA, documentId)).rejects.toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });

    expect(llm.callCount).toBe(0);
  });

  it("positive control: fewer findings of the same passage fit, and generate in one model call", async () => {
    const documentId = await analyzedWith(25);
    const llm = new FakeLlmClient({ defaultResponse: { data: prepareOutput } });

    const result = complete(await generate(h.deps(llm), guestA, documentId));

    expect(result.lawyerQuestions).toHaveLength(1);
    expect(llm.callCount).toBe(1);
    expect(llm.calls[0].userPrompt.length).toBeLessThanOrEqual(MODEL_INPUT_BUDGET_CHARS.prepare);
  });
});
