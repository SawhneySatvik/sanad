// The reader lens a Prepare call is written for: which of the document type's lenses feeds the
// per-finding explanation and the system prompt's reader framing, the response's echoed lens, and
// the Markdown header.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import { LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";
import { generate } from "@/server/services/prepare";
import { analyze } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import {
  aliasFor,
  analyzeLease,
  complete,
  createHarness,
  guestA,
  type Harness,
  LEASE,
  leaseFinding,
  MIME,
} from "@tests/support/services/prepare";

const TENANT_ABOUT_TO_SIGN = LENSES_BY_DOCUMENT_TYPE.leave_and_license[0];
const TENANT_ALREADY_SIGNED = LENSES_BY_DOCUMENT_TYPE.leave_and_license.find((lens) => lens.id === "tenant_already_signed")!;
// job_offer_letter's lens — a real lens id, but not one of leave_and_license's.
const WRONG_TYPE_LENS = LENSES_BY_DOCUMENT_TYPE.job_offer_letter[0].id;

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

function scriptFor(alias: string) {
  return new FakeLlmClient({
    responses: [{ data: { lawyerQuestions: [{ question: "q", whyItMatters: "w", findingIds: [alias] }], checklist: [] } }],
  });
}

describe("generate() — lens selection", () => {
  it("precondition: the fixture's default and already-signed explanations differ for the same finding", async () => {
    // If they were equal, no assertion below could tell a working lensId apart from an ignored one.
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    expect(feeFinding.explanation).not.toBe(feeFinding.lensExplanations.find((l) => l.lens === TENANT_ALREADY_SIGNED.id)?.explanation);
  });

  it("with no lensId, the prompt carries exactly the finding's default explanation", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = scriptFor(feeAlias);

    await generate(h.deps(llm), guestA, analyzed.document.id);

    expect(llm.calls[0].userPrompt).toContain(`explanation: ${feeFinding.explanation}`);
  });

  it("with an explicit lensId, the prompt carries THAT lens's explanation, not the default one", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const alreadySignedExplanation = feeFinding.lensExplanations.find((l) => l.lens === TENANT_ALREADY_SIGNED.id)!.explanation;
    const llm = scriptFor(feeAlias);

    await generate(h.deps(llm), guestA, analyzed.document.id, TENANT_ALREADY_SIGNED.id);

    expect(llm.calls[0].userPrompt).toContain(`explanation: ${alreadySignedExplanation}`);
    expect(llm.calls[0].userPrompt).not.toContain(`explanation: ${feeFinding.explanation}`);
  });

  it("the system prompt names the reader by the chosen lens's own description and stage guidance", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);
    const llm = scriptFor(feeAlias);

    await generate(h.deps(llm), guestA, analyzed.document.id, TENANT_ALREADY_SIGNED.id);

    expect(llm.calls[0].systemPrompt).toContain(TENANT_ALREADY_SIGNED.description);
    expect(llm.calls[0].systemPrompt).toContain("enforcing their rights");
    expect(llm.calls[0].systemPrompt).not.toContain("can still negotiate");
  });

  it("a standard-clause checklist gap's explanation is reader-neutral and unaffected by the chosen lens", async () => {
    const understandLlm = new FakeLlmClient({ responses: [{ data: { findings: [leaseFinding("obligation", LEASE.licenseFee, "Fee")] } }] });
    const analyzed = await analyze(h.deps(understandLlm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
    const gap = analyzed.findings.find((finding) => finding.provenance === "checklist")!;
    const alias = aliasFor(analyzed.findings, gap);
    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [], checklist: [{ item: "Ask who pays stamp duty and registration.", findingIds: [alias] }] } }],
    });

    await generate(h.deps(llm), guestA, analyzed.document.id, TENANT_ALREADY_SIGNED.id);

    expect(llm.calls[0].userPrompt).toContain(`explanation: ${gap.explanation}`);
  });

  it("the response echoes the resolved lens: the document type's first lens by default, or the requested one", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);

    const byDefault = complete(await generate(h.deps(scriptFor(feeAlias)), guestA, analyzed.document.id));
    expect(byDefault.lens).toEqual(TENANT_ABOUT_TO_SIGN);

    const chosen = complete(await generate(h.deps(scriptFor(feeAlias)), guestA, analyzed.document.id, TENANT_ALREADY_SIGNED.id));
    expect(chosen.lens).toEqual(TENANT_ALREADY_SIGNED);
  });

  it("the Markdown header names the chosen perspective", async () => {
    const analyzed = await analyzeLease(h);
    const feeFinding = analyzed.findings.find((f) => f.quote === LEASE.licenseFee)!;
    const feeAlias = aliasFor(analyzed.findings, feeFinding);

    const result = complete(await generate(h.deps(scriptFor(feeAlias)), guestA, analyzed.document.id, TENANT_ALREADY_SIGNED.id));

    expect(result.markdown).toContain("Prepared for: Tenant, already signed");
  });

  it("an unknown lens id is VALIDATION_FAILED, with no LLM call", async () => {
    const analyzed = await analyzeLease(h);
    const llm = new FakeLlmClient();

    await expect(generate(h.deps(llm), guestA, analyzed.document.id, "not_a_real_lens")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    } satisfies Partial<AppError>);
    expect(llm.callCount).toBe(0);
  });

  it("a lens id belonging to a different document type is VALIDATION_FAILED, with no LLM call", async () => {
    const analyzed = await analyzeLease(h);
    const llm = new FakeLlmClient();

    await expect(generate(h.deps(llm), guestA, analyzed.document.id, WRONG_TYPE_LENS)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    } satisfies Partial<AppError>);
    expect(llm.callCount).toBe(0);
  });
});
