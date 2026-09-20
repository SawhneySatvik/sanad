import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STANDARD_CLAUSES_BY_DOCUMENT_TYPE } from "@/server/deterministic/standard-clauses";
import { analyze } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, findingsOf, FIXTURES_DIR, guestA, type Harness, LEASE, leaseFinding, MIME } from "@tests/support/services/understand";

// Only a model finding that is itself an absence claim — category missing_clause — can stand in for
// a checklist gap. The same absence wording under any other category leaves the gap listed.

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const STAMP_DUTY_GAP = STANDARD_CLAUSES_BY_DOCUMENT_TYPE.leave_and_license.find((item) => item.id === "registration_and_stamp_duty")!.explanation;
const ABSENCE = "No clause on who pays stamp duty and registration";

async function checklistExplanations(finding: ReturnType<typeof leaseFinding>): Promise<string[]> {
  const bytes = await readFile(path.join(FIXTURES_DIR, "leave_and_license.txt"));
  const llm = new FakeLlmClient({ responses: [{ data: { findings: [finding] } }] });
  const analyzed = await analyze(h.deps(llm), guestA, await h.uploadBytes(guestA, "lease.txt", MIME.txt, bytes));
  return findingsOf(analyzed).flatMap((f) => (f.provenance === "checklist" ? [f.explanation] : []));
}

describe("get — which model findings stand in for a checklist gap", () => {
  it("positive control: a missing_clause finding saying the clause is absent replaces the gap", async () => {
    expect(await checklistExplanations(leaseFinding("missing_clause", null, ABSENCE))).not.toContain(STAMP_DUTY_GAP);
  });

  it("regression guard: the same absence wording on an obligation finding leaves the gap listed", async () => {
    expect(await checklistExplanations(leaseFinding("obligation", LEASE.licenseFee, ABSENCE))).toContain(STAMP_DUTY_GAP);
  });
});
