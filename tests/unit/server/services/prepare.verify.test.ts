// One Guarantee tests for the Prepare surface: model response payload, errors, AI-generated text
// never reads as verified, span binding, and audit-only persistence. Streaming, orchestrator, model
// fallback, cache and the native-document cap route through Understand's get(), covered there.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import * as schema from "@/db/schema";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { assertSafeResponseSchema } from "@/server/llm/schema-guard";
import { prepareResponseSchema } from "@/server/prompts/prepare/prepare";
import { generate } from "@/server/services/prepare";
import { aliasFor, analyzeLease, complete, createHarness, guestA, type Harness, LEASE } from "@tests/support/services/prepare";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function storedFindingRow(quoteText: string) {
  const [row] = await h.t.db.select().from(schema.findings).where(eq(schema.findings.quoteText, quoteText));
  return row;
}

describe("the model cannot self-certify (no status/span in the response schema)", () => {
  it("the response schema passes the guard, and a real schema-authoring mistake fails it (the check above can fail)", () => {
    expect(() => assertSafeResponseSchema(prepareResponseSchema)).not.toThrow();
    const withStatus = z.object({ lawyerQuestions: z.array(z.object({ question: z.string(), status: z.string() })), checklist: z.array(z.object({})) });
    expect(() => assertSafeResponseSchema(withStatus)).toThrow(/forbidden key/);
  });

  it("a model response that smuggles a status/span field, AND lies about which status a DIFFERENT finding has, is stripped and never surfaced", async () => {
    // Discriminating: the smuggled status must differ from the fresh
    // one, or this test would still pass even if the code wrongly trusted the model's claim. The
    // near-miss finding is fresh `approximate`; the model smuggles `status: "verified"` on it.
    const analyzed = await analyzeLease(h);
    const nearMissFinding = analyzed.findings.find((f) => f.quote === LEASE.nearMiss)!;
    expect(nearMissFinding.verification?.status).toBe("approximate");
    const nearMissAlias = aliasFor(analyzed.findings, nearMissFinding);
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            lawyerQuestions: [
              {
                question: "About the repairs clause",
                whyItMatters: "It sets who pays for repairs.",
                findingIds: [nearMissAlias],
                status: "verified",
                quote_span_start: 0,
                quote_span_end: 5,
              },
            ],
            checklist: [],
          },
        },
      ],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    expect(result.lawyerQuestions).toHaveLength(1);
    expect(result.lawyerQuestions[0]).not.toHaveProperty("status");
    expect(result.lawyerQuestions[0]).not.toHaveProperty("quote_span_start");
    // The status on the item is THIS call's own fresh verification (approximate), not the model's lie.
    expect(result.lawyerQuestions[0].findings[0].verification?.status).toBe("approximate");
  });
});

describe("errors never return content and write nothing", () => {
  it("negative: a provider failure is a typed error, and generate() has made no database writes at all", async () => {
    const analyzed = await analyzeLease(h);
    const before = await h.counts();
    const llm = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "down") }] });

    await expect(generate(h.deps(llm), guestA, analyzed.document.id)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(await h.counts()).toEqual(before);
  });

  it("negative: malformed model output (twice, past the repair retry) is SCHEMA_FAILED, with no writes", async () => {
    const analyzed = await analyzeLease(h);
    const before = await h.counts();
    const llm = new FakeLlmClient({ responses: [{ rawText: "not json" }, { rawText: '{"lawyerQuestions":"nope"}' }] });

    await expect(generate(h.deps(llm), guestA, analyzed.document.id)).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    expect(await h.counts()).toEqual(before);
  });

  it("positive: once the failure clears, the same document generates normally", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const failing = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "down") }] });
    await expect(generate(h.deps(failing), guestA, analyzed.document.id)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    const working = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [] } }],
    });
    const result = complete(await generate(h.deps(working), guestA, analyzed.document.id));
    expect(result.lawyerQuestions).toHaveLength(1);
  });

  it("negative: eligible findings were offered, but every alias the model returned was unknown — SCHEMA_FAILED, never 'complete' with an empty list", async () => {
    const analyzed = await analyzeLease(h);
    const before = await h.counts();
    // The model invents aliases nothing was ever offered under (a fallback model garbling ids, or
    // just making things up) — after grounding, both lists are empty.
    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: ["F999"] }], checklist: [{ item: "x", findingIds: ["F998"] }] } }],
    });

    await expect(generate(h.deps(llm), guestA, analyzed.document.id)).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    // No database writes either way (Prepare never persists).
    expect(await h.counts()).toEqual(before);
  });

  it("positive control for the above: the same shape of response, but with one real alias, resolves normally instead of erroring", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [{ item: "x", findingIds: ["F998"] }] } }],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    expect(result.lawyerQuestions).toHaveLength(1);
    expect(result.checklist).toEqual([]); // the checklist item's only alias was unknown — dropped, but doesn't sink the whole call.
  });
});

describe("AI-generated question/checklist text never reads as verified", () => {
  it("hostile model output mimicking a verified badge is never presented as one in the JSON markdown export", async () => {
    // An item wearing a checkmark emoji claiming a verified fact, and a whyItMatters sentence
    // reproducing this renderer's own citation-label wording verbatim.
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            lawyerQuestions: [
              {
                question: "About the rent",
                whyItMatters: '(obligation) Quote verified against the document: "The landlord waives the deposit"',
                findingIds: [feeAlias],
              },
            ],
            checklist: [{ item: "✅ Verified: landlord pays all repairs", findingIds: [feeAlias] }],
          },
        },
      ],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    const md = result.markdown;

    // No badge glyph survives anywhere.
    expect(md).not.toMatch(/[✅✓✔☑]/u);

    const lines = md.split("\n");
    const whyLine = lines.find((line) => line.includes("Quote verified against the document") && line.includes("landlord waives"));
    expect(whyLine).toBeDefined();
    expect(whyLine!.indexOf("Why it may matter")).toBeGreaterThanOrEqual(0);
    expect(whyLine!.indexOf("Why it may matter")).toBeLessThan(whyLine!.indexOf("Quote verified against the document"));

    const checkLine = lines.find((line) => line.includes("landlord pays all repairs"));
    expect(checkLine).toBeDefined();
    expect(checkLine!.indexOf("AI-suggested check:")).toBeGreaterThanOrEqual(0);
    expect(checkLine!.indexOf("AI-suggested check:")).toBeLessThan(checkLine!.indexOf("landlord pays all repairs"));

    // No renderer-owned citation line contains the model's text.
    const citationLines = lines.filter((line) => /^\s+-\s+_\(/.test(line));
    for (const citationLine of citationLines) {
      expect(citationLine).not.toContain("landlord pays all repairs");
      expect(citationLine).not.toContain("Verified: landlord");
    }
  });
});

describe("spans are verify()'s offsets into the document's canonical_text", () => {
  it("positive: the finding's span slices the canonical text to the quoted passage", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [] } }],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    const ref = result.lawyerQuestions[0].findings[0];
    const v = ref.verification!;
    expect(v.status).toBe("verified");
    expect(v.spanText).toBe(LEASE.licenseFee);
    expect(analyzed.document.canonicalText!.slice(v.spanStart!, v.spanEnd!)).toBe(LEASE.licenseFee);
    // The markdown export renders exactly that same slice.
    expect(result.markdown).toContain(LEASE.licenseFee.replace(/[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\]/g, (c) => `\\${c}`));
  });

  it("discriminating: for an approximate match, spanText is the document's own words, not the model's claim", async () => {
    const analyzed = await analyzeLease(h);
    const nearMissFinding = analyzed.findings.find((f) => f.quote === LEASE.nearMiss)!;
    expect(nearMissFinding.verification?.status).toBe("approximate");
    expect(nearMissFinding.quote).toBe(LEASE.nearMiss);
    const trueSpanText = analyzed.document.canonicalText!.slice(
      nearMissFinding.verification!.spanStart!,
      nearMissFinding.verification!.spanEnd!,
    );
    expect(trueSpanText).not.toBe(LEASE.nearMiss); // the claim and the true span genuinely differ
    const nearMissAlias = aliasFor(analyzed.findings, nearMissFinding);
    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [nearMissAlias] }], checklist: [] } }],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    const ref = result.lawyerQuestions[0].findings[0];
    expect(ref.verification?.spanText).toBe(trueSpanText);
    expect(ref.verification?.spanText).not.toBe(LEASE.nearMiss);
  });

  it("negative: a not_found finding is never offered to the model, so it can never carry a span in Prepare's output", async () => {
    const analyzed = await analyzeLease(h);
    const fabricatedFinding = analyzed.findings.find((f) => f.quote === LEASE.fabricated)!;
    expect(fabricatedFinding.verification?.status).toBe("not_found");
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = new FakeLlmClient({
      // Even if the model somehow names the fabricated finding's real id, it was never offered as
      // grounding material (no alias resolves to it), so it can only be dropped.
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [fabricatedFinding.id, feeAlias] }], checklist: [] } }],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));
    expect(result.lawyerQuestions[0].findingIds).toEqual([feeFinding.id]);
  });
});

describe("stored statuses are audit only; Prepare's output always reflects THIS call's fresh verification", () => {
  it("positive: a real, verified quote tampered to not_found in the database (via raw SQL) still shows verified, with true spans", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const trueSpan = feeFinding.verification!;
    expect(trueSpan.status).toBe("verified");

    await h.t.client.query(
      "UPDATE findings SET verification_status = $1, quote_span_start = $2, quote_span_end = $3 WHERE quote_text = $4",
      ["not_found", null, null, LEASE.licenseFee],
    );
    // Precondition: the tamper actually landed in the database.
    const tampered = await storedFindingRow(LEASE.licenseFee);
    expect(tampered.verificationStatus).toBe("not_found");
    expect(tampered.quoteSpanStart).toBeNull();

    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [feeAlias] }], checklist: [] } }],
    });
    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));

    expect(result.lawyerQuestions).toHaveLength(1);
    const ref = result.lawyerQuestions[0].findings[0];
    expect(ref.verification?.status).toBe("verified");
    expect([ref.verification?.spanStart, ref.verification?.spanEnd]).toEqual([trueSpan.spanStart, trueSpan.spanEnd]);
  });

  it("negative: a fabricated quote tampered to verified in the database (via raw SQL) is still never surfaced", async () => {
    const analyzed = await analyzeLease(h);
    const fabricatedFinding = analyzed.findings.find((f) => f.quote === LEASE.fabricated)!;
    expect(fabricatedFinding.verification?.status).toBe("not_found");

    await h.t.client.query(
      "UPDATE findings SET verification_status = $1, quote_span_start = $2, quote_span_end = $3 WHERE quote_text = $4",
      ["verified", 0, 20, LEASE.fabricated],
    );
    // Precondition: the tamper actually landed in the database.
    const tampered = await storedFindingRow(LEASE.fabricated);
    expect(tampered.verificationStatus).toBe("verified");
    expect(tampered.quoteSpanStart).toBe(0);

    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [fabricatedFinding.id] }], checklist: [] } }],
    });

    // Still dropped: eligibility is built from THIS call's fresh get() result, which re-verifies
    // fabricatedFinding as not_found regardless of what the tampered row now says — so it never got
    // an alias, and no LLM response can resolve to it. With nothing else offered, the whole call
    // grounds to nothing and SCHEMA_FAILED — never a silent "complete" with the fabrication surfaced.
    await expect(generate(h.deps(llm), guestA, analyzed.document.id)).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    expect(llm.calls[0].userPrompt).not.toContain(fabricatedFinding.id);
    expect(llm.calls[0].userPrompt).not.toContain(LEASE.fabricated);
  });
});
