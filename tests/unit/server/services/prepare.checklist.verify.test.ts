import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareView } from "@/server/http/views/prepare-view";
import { generate } from "@/server/services/prepare";
import { analyze } from "@/server/services/understand";
import { PrepareOutput } from "@/shared/contracts/prepare";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import {
  aliasFor,
  complete,
  createHarness,
  guestA,
  type Harness,
  LEASE,
  leaseFinding,
  MIME,
} from "@tests/support/services/prepare";

// A standard-clause checklist gap reaches Prepare like a model missing_clause: offered to the model
// with no quote, cited by its id, and shown without any status — absence is never "verified".

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("generate — a standard-clause checklist gap", () => {
  it("is offered as a quote-less missing_clause and cited with no status, under the possibly-missing label", async () => {
    const understandLlm = new FakeLlmClient({ responses: [{ data: { findings: [leaseFinding("obligation", LEASE.licenseFee, "Fee")] } }] });
    const analyzed = await analyze(h.deps(understandLlm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
    const gap = analyzed.findings.find((finding) => finding.provenance === "checklist");
    expect(gap).toBeDefined();
    const alias = aliasFor(analyzed.findings, gap!);
    const llm = new FakeLlmClient({
      responses: [{ data: { lawyerQuestions: [], checklist: [{ item: "Ask who pays stamp duty and registration.", findingIds: [alias] }] } }],
    });

    const result = complete(await generate(h.deps(llm), guestA, analyzed.document.id));

    expect(llm.calls[0].userPrompt).toContain(gap!.explanation);
    expect(result.checklist).toHaveLength(1);
    expect(result.checklist[0].findingIds).toEqual([gap!.id]);
    expect(result.checklist[0].findings).toEqual([{ id: gap!.id, category: "missing_clause", verification: null }]);
    expect(result.markdown).toContain("Flagged as possibly missing — not checked against the document");
    expect(result.markdown).not.toContain("Quote verified against the document");
    const wire = PrepareOutput.parse(prepareView(result));
    expect(wire.state === "complete" && wire.checklist[0].findings[0].verification).toBeNull();
  });
});
