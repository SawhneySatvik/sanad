import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readyDocument } from "@tests/support/data/documents";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { LLM_TIMEOUT_MS } from "@/server/llm/timeouts";
import { MAX_CHECKLIST_ITEMS, MAX_FINDING_IDS_PER_ITEM, MAX_LAWYER_QUESTIONS } from "@/server/prompts/prepare/prepare";
import { eligibleFindings, generate } from "@/server/services/prepare";
import { analyze } from "@/server/services/understand";
import {
  aliasFor,
  analyzeLease,
  complete,
  createHarness,
  guestA,
  type Harness,
  LEASE,
  leaseFinding,
  lensExplanationsFor,
  MIME,
  UNKNOWN_ALIAS,
} from "@tests/support/services/prepare";

// A generic document has no standard-clause checklist, so the model's findings are the only ones.
const GENERIC_SENTENCE = "Members water the raised beds on their assigned mornings before nine o'clock.";
const genericFinding = (category: string, quote: string, subject: string) => ({
  category,
  quote,
  lensExplanations: lensExplanationsFor("generic", subject),
});

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("generate — not_analyzed", () => {
  it("a ready document with no analysis returns a typed not_analyzed result and makes no LLM call", async () => {
    const document = await readyDocument(h.t, guestA);
    const llm = new FakeLlmClient();

    const result = await generate(h.deps(llm), guestA, document.id);

    expect(result.state).toBe("not_analyzed");
    expect(result.document.id).toBe(document.id);
    expect(llm.callCount).toBe(0);
  });
});

describe("generate — no_grounded_findings: never reported as complete", () => {
  it("an analysis with zero findings returns the typed no_grounded_findings state, no LLM call", async () => {
    const understandLlm = new FakeLlmClient({ responses: [{ data: { findings: [] } }] });
    const input = await h.upload(guestA, "generic.txt", MIME.txt);
    const analyzed = await analyze(h.deps(understandLlm), guestA, input);

    const llm = new FakeLlmClient();
    const result = await generate(h.deps(llm), guestA, analyzed.document.id);

    expect(result.state).toBe("no_grounded_findings");
    expect(result.document.id).toBe(analyzed.document.id);
    expect(llm.callCount).toBe(0);
  });

  it("an analysis where every finding is not_found is also zero-eligible: no_grounded_findings, no LLM call", async () => {
    const understandLlm = new FakeLlmClient({
      responses: [{ data: { findings: [genericFinding("penalty", LEASE.fabricated, "Late fee")] } }],
    });
    const input = await h.upload(guestA, "generic.txt", MIME.txt);
    const analyzed = await analyze(h.deps(understandLlm), guestA, input);
    expect(analyzed.findings[0].verification?.status).toBe("not_found");

    const llm = new FakeLlmClient();
    const result = await generate(h.deps(llm), guestA, analyzed.document.id);

    expect(result.state).toBe("no_grounded_findings");
    expect(llm.callCount).toBe(0);
  });
});

describe("generate — grounding: unknown aliases and not_found findings are never surfaced", () => {
  it("drops an unknown alias, drops an item left with zero valid aliases, and never offers a not_found finding to the model", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const fabricatedFinding = analyzed.findings.find((f) => f.quote === LEASE.fabricated)!;
    const missingClauseFinding = analyzed.findings.find((f) => f.category === "missing_clause")!;
    expect(feeFinding.verification?.status).toBe("verified");
    expect(fabricatedFinding.verification?.status).toBe("not_found");
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const missingClauseAlias = aliasFor(analyzed.findings, missingClauseFinding);

    const llm = new FakeLlmClient({
      modelUsed: "fake-prepare-model",
      responses: [
        {
          data: {
            lawyerQuestions: [
              // Kept: one valid alias + one the model invented — the invented one is dropped, the item survives.
              { question: "What is the monthly rent?", whyItMatters: "It is your main recurring cost.", findingIds: [feeAlias, UNKNOWN_ALIAS] },
              // Dropped entirely: nothing left once the only alias is filtered out.
              { question: "Generic question", whyItMatters: "Generic.", findingIds: [UNKNOWN_ALIAS] },
              // Dropped entirely: the fabricated finding was never eligible, so it never got an alias at
              // all — its real UUID, passed here as if it were an alias, resolves to nothing.
              { question: "About the late fee", whyItMatters: "Ask about it.", findingIds: [fabricatedFinding.id] },
            ],
            checklist: [{ item: "Ask your lawyer about stamp duty and registration.", findingIds: [missingClauseAlias] }],
          },
        },
      ],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));

    expect(result.modelUsed).toBe("fake-prepare-model");
    expect(result.promptVersion).toMatch(/\S/);
    expect(result.lawyerQuestions).toHaveLength(1);
    expect(result.lawyerQuestions[0].findingIds).toEqual([feeFinding.id]);
    expect(result.lawyerQuestions[0].findings).toHaveLength(1);
    expect(result.lawyerQuestions[0].findings[0].id).toBe(feeFinding.id);
    expect(result.lawyerQuestions[0].findings[0].verification?.status).toBe("verified");

    expect(result.checklist).toHaveLength(1);
    expect(result.checklist[0].findingIds).toEqual([missingClauseFinding.id]);
    expect(result.checklist[0].findings[0].verification).toBeNull();

    // The fabricated finding was never even offered to the model as grounding material — neither its
    // real UUID nor any alias resolving to it appears in the prompt.
    const userPrompt = llm.calls[0].userPrompt;
    expect(userPrompt).not.toContain(fabricatedFinding.id);
    expect(userPrompt).not.toContain(LEASE.fabricated);
    expect(userPrompt).toContain(feeAlias);
    expect(userPrompt).toContain(missingClauseAlias);
  });

  it("de-duplicates a repeated alias within one item's findingIds", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [feeAlias, feeAlias] }],
            checklist: [],
          },
        },
      ],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    expect(result.lawyerQuestions[0].findingIds).toEqual([feeFinding.id]);
    expect(result.lawyerQuestions[0].findings).toHaveLength(1);
  });

  it("excludes an unquoted, non-missing_clause finding — the same risk as a not_found finding, never just 'possibly missing'", async () => {
    // understand.ts's toClaims nulls a quote whenever the model leaves one blank, for ANY category,
    // not only missing_clause — so this shape (verification === null on a non-missing_clause
    // finding) is real and must not be treated as grounded.
    const understandLlm = new FakeLlmClient({
      responses: [{ data: { findings: [leaseFinding("obligation", null, "An unquoted claim"), leaseFinding("obligation", LEASE.licenseFee, "Fee")] } }],
    });
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
    const analyzed = await analyze(h.deps(understandLlm), guestA, input);
    const unquotedFinding = analyzed.findings.find((f) => f.explanation === "An unquoted claim — as seen by tenant_about_to_sign.")!;
    expect(unquotedFinding.category).toBe("obligation");
    expect(unquotedFinding.verification).toBeNull();
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);

    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            // The unquoted finding never got an alias at all (not eligible) — its real UUID, passed as
            // if it were an alias, resolves to nothing, same as any other unknown alias.
            lawyerQuestions: [{ question: "About the unquoted claim", whyItMatters: "w", findingIds: [unquotedFinding.id, feeAlias] }],
            checklist: [],
          },
        },
      ],
    });
    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));

    expect(result.lawyerQuestions[0].findingIds).toEqual([feeFinding.id]);
    expect(llm.calls[0].userPrompt).not.toContain(unquotedFinding.id);
  });

  it("trims to MAX_FINDING_IDS_PER_ITEM only after de-duplicating aliases (a repeated alias doesn't burn the cap)", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const noticeFinding = analyzed.findings.find((f) => f.quote === LEASE.notice)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const noticeAlias = aliasFor(analyzed.findings, noticeFinding);
    // 7 entries, only 2 unique aliases — without post-dedup trimming this would have hard-failed the
    // (now-generous) schema max or silently dropped a real, valid alias.
    const findingIds = [feeAlias, feeAlias, feeAlias, feeAlias, feeAlias, feeAlias, noticeAlias];
    const llm = new FakeLlmClient({ responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds }], checklist: [] } }] });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    expect(result.lawyerQuestions[0].findingIds.sort()).toEqual([feeFinding.id, noticeFinding.id].sort());
  });

  it("a response over any schema-level ceiling (25 questions or items, 20 ids per item) is trimmed to the business caps, not failed", async () => {
    const analyzed = await analyzeLease(h);
    const eligible = eligibleFindings(analyzed.findings);
    expect(eligible.length).toBeGreaterThan(MAX_FINDING_IDS_PER_ITEM);
    const aliases = eligible.map((_, i) => `F${i + 1}`);
    const findingIds = [...aliases, ...aliases, ...aliases];
    expect(findingIds.length).toBeGreaterThan(20);
    const lawyerQuestions = Array.from({ length: 30 }, (_, i) => ({ question: `Question ${i}?`, whyItMatters: "w", findingIds }));
    const checklist = Array.from({ length: 30 }, (_, i) => ({ item: `Item ${i}`, findingIds }));
    // One queued response: a schema rejection would spend the repair retry, find the queue empty and throw.
    const llm = new FakeLlmClient({ responses: [{ data: { lawyerQuestions, checklist } }] });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));

    expect(llm.callCount).toBe(1);
    expect(result.lawyerQuestions.map((q) => q.question)).toEqual(lawyerQuestions.slice(0, MAX_LAWYER_QUESTIONS).map((q) => q.question));
    expect(result.checklist.map((c) => c.item)).toEqual(checklist.slice(0, MAX_CHECKLIST_ITEMS).map((c) => c.item));
    const expectedIds = eligible.slice(0, MAX_FINDING_IDS_PER_ITEM).map((finding) => finding.id);
    for (const entry of [...result.lawyerQuestions, ...result.checklist]) expect(entry.findingIds).toEqual(expectedIds);
    expect(result.dropped).toEqual({
      lawyerQuestions: { ungrounded: 0, blank: 0, duplicate: 0, overCap: lawyerQuestions.length - MAX_LAWYER_QUESTIONS },
      checklist: { ungrounded: 0, blank: 0, duplicate: 0, overCap: checklist.length - MAX_CHECKLIST_ITEMS },
      findingIdsOverCap: (MAX_LAWYER_QUESTIONS + MAX_CHECKLIST_ITEMS) * (eligible.length - MAX_FINDING_IDS_PER_ITEM),
    });
  });

  it("a repeated question or item (same text up to case and spacing) is dropped before the cap, so repeats never crowd out distinct entries; logged as counts only", async () => {
    const analyzed = await analyzeLease(h);
    const feeAlias = aliasFor(analyzed.findings, analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!);
    const ask = (question: string, findingIds = [feeAlias]) => ({ question, whyItMatters: "w", findingIds });
    const repeats = ["Is the lock-in binding on me?", "is the lock-in  binding on me?", "  IS THE LOCK-IN BINDING ON ME?", "Is the\tlock-in binding on me?"];
    const distinct = Array.from({ length: MAX_LAWYER_QUESTIONS }, (_, i) => `Distinct question ${i}?`);
    const lawyerQuestions = [ask("Ungrounded question?", [UNKNOWN_ALIAS]), ...repeats.map((q) => ask(q)), ...distinct.map((q) => ask(q))];
    const checklist = [
      { item: "Bring the deposit receipt", findingIds: [feeAlias] },
      { item: "bring the deposit receipt ", findingIds: [feeAlias] },
      { item: "Note the notice date", findingIds: [feeAlias] },
    ];
    const llm = new FakeLlmClient({ responses: [{ data: { lawyerQuestions, checklist } }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));

      expect(result.lawyerQuestions.map((q) => q.question)).toEqual([repeats[0], ...distinct.slice(0, MAX_LAWYER_QUESTIONS - 1)]);
      expect(result.checklist.map((c) => c.item)).toEqual(["Bring the deposit receipt", "Note the notice date"]);
      const dropped = {
        lawyerQuestions: { ungrounded: 1, blank: 0, duplicate: repeats.length - 1, overCap: 1 },
        checklist: { ungrounded: 0, blank: 0, duplicate: 1, overCap: 0 },
        findingIdsOverCap: 0,
      };
      expect(result.dropped).toEqual(dropped);
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.filter((line) => line.includes("llm_output_trimmed")).map((line) => JSON.parse(line))).toEqual([
        { event: "llm_output_trimmed", surface: "prepare", documentId: analyzed.document.id, modelUsed: "fake-model", ...dropped },
      ]);
      expect(lines.join("\n")).not.toMatch(/lock-in|deposit receipt|Distinct question/i);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("generate — grounding sends the verified SPAN text to the model, not the claimed quote", () => {
  it("for an approximate match, the model sees the document's own words at the span, not the model's original claim", async () => {
    const analyzed = await analyzeLease(h);
    const nearMissFinding = analyzed.findings.find((f) => f.quote === LEASE.nearMiss)!;
    expect(nearMissFinding.verification?.status).toBe("approximate");
    const spanText = analyzed.document.canonicalText!.slice(
      nearMissFinding.verification!.spanStart!,
      nearMissFinding.verification!.spanEnd!,
    );
    expect(spanText).not.toBe(LEASE.nearMiss);
    const nearMissAlias = aliasFor(analyzed.findings, nearMissFinding);

    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [nearMissAlias] }], checklist: [] } }],
    });
    await generate(h.deps(llm), guestA, analyzed.document.id);

    const userPrompt = llm.calls[0].userPrompt;
    expect(userPrompt).toContain(spanText);
    expect(userPrompt).not.toContain(LEASE.nearMiss);
  });
});

describe("generate — non-blank question/whyItMatters/item text", () => {
  it("a blank question is rejected at parse, triggers the repair retry, and SCHEMA_FAILED if it stays blank", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = new FakeLlmClient({
      responses: [
        { data: { lawyerQuestions: [{ question: "   ", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [] } },
        { data: { lawyerQuestions: [{ question: "   ", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [] } },
      ],
    });
    await expect(generate(h.deps(llm), guestA, analyzed.document.id)).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
  });
});

describe("generate — the markdown export is produced alongside the structured output", () => {
  it("carries the not-legal-advice notice and the grounded, AI-prefixed question", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            lawyerQuestions: [{ question: "What is the monthly rent?", whyItMatters: "It is your main cost.", findingIds: [feeAlias] }],
            checklist: [],
          },
        },
      ],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    expect(result.markdown).toContain("not legal advice");
    expect(result.markdown).toContain("AI-suggested question:");
    expect(result.markdown).toContain("What is the monthly rent");
  });
});

describe("generate — internal finding aliases never reach the reader", () => {
  it("scrubs every alias this call offered from question/whyItMatters/item text; findingIds keep the real mapping; unoffered tokens survive", async () => {
    // Twelve eligible findings, so F11 and F12 are real aliases and F13/F999 are not.
    const understandLlm = new FakeLlmClient({
      responses: [{ data: { findings: Array.from({ length: 12 }, (_, i) => genericFinding("obligation", GENERIC_SENTENCE, `Finding ${i}`)) } }],
    });
    const analyzed = await analyze(h.deps(understandLlm), guestA, await h.upload(guestA, "generic.txt", MIME.txt));
    const eligible = eligibleFindings(analyzed.findings);
    expect(eligible).toHaveLength(12);
    // Shapes seen in real model output: "(F1)", "as stated in F11", runs of several.
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            lawyerQuestions: [
              {
                question: "What happens to my deposit, as noted in F11, if I leave early?",
                whyItMatters: "F3 and F4 conflict on the notice period.",
                findingIds: ["F11", "F3", "F4"],
              },
              { question: "Is the lock-in enforceable (F1)?", whyItMatters: "Findings F1, F2 set the term. See F12.", findingIds: ["F1"] },
            ],
            checklist: [
              { item: "Bring Form F999 and the rent receipts (see F2, F5)", findingIds: ["F2"] },
              { item: "Check F13 against F1", findingIds: ["F1"] },
              { item: "(F2)", findingIds: ["F2"] },
            ],
          },
        },
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let result;
    try {
      result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    } finally {
      warn.mockRestore();
    }

    expect(result.lawyerQuestions.map((q) => [q.question, q.whyItMatters])).toEqual([
      ["What happens to my deposit, as noted in the linked finding, if I leave early?", "The linked findings conflict on the notice period."],
      ["Is the lock-in enforceable?", "The linked findings set the term. See the linked finding."],
    ]);
    expect(result.checklist.map((c) => c.item)).toEqual(["Bring Form F999 and the rent receipts", "Check F13 against the linked finding"]);
    expect(result.lawyerQuestions[0].findingIds).toEqual([eligible[10].id, eligible[2].id, eligible[3].id]);
    // "(F2)" alone was only an alias: blank once scrubbed, so dropped and counted.
    expect(result.dropped?.checklist.blank).toBe(1);
    expect(result.markdown).not.toMatch(/\bF(?:[1-9]|1[0-2])\b/);
    expect(llm.calls[0].systemPrompt).toContain("Never write an id (such as F1)");
    expect(llm.calls[0].timeoutMs).toBe(LLM_TIMEOUT_MS.prepare);
  });
});
