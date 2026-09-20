import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMissingStandardClauses, STANDARD_CLAUSES_BY_DOCUMENT_TYPE } from "@/server/deterministic/standard-clauses";
import { analyze, get, type UnderstandResult } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import {
  createHarness,
  findingsOf,
  FIXTURES_DIR,
  guestA,
  type Harness,
  LEASE,
  LEASE_FINDING_COUNT,
  leaseFinding,
  leaseOutput,
  MIME,
} from "@tests/support/services/understand";

// get() appends the standard-clause checklist's gaps to the model's findings. A gap quotes nothing,
// so it must never carry a verification: absence is never "verified".

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const checklistExplanation = (itemId: string) =>
  STANDARD_CLAUSES_BY_DOCUMENT_TYPE.leave_and_license.find((item) => item.id === itemId)!.explanation;
const checklistFindings = (result: UnderstandResult) =>
  findingsOf(result).filter((finding) => finding.provenance === "checklist");

// `suffix` changes the text, and so the content-keyed analysis cache entry, when a test needs a
// second analysis with a different model response.
async function analyzeLease(findings: unknown[], suffix = "") {
  const text = (await readFile(path.join(FIXTURES_DIR, "leave_and_license.txt"), "utf8")) + suffix;
  const llm = new FakeLlmClient({ responses: [{ data: { findings } }] });
  const input = await h.uploadBytes(guestA, "leave_and_license.txt", MIME.txt, new TextEncoder().encode(text));
  return analyze(h.deps(llm), guestA, input);
}

describe("get — standard-clause checklist gaps", () => {
  it("appends the gaps after the model's findings as quote-less missing_clause findings with no verification", async () => {
    const result = await analyzeLease(leaseOutput().findings);
    const gaps = findMissingStandardClauses("leave_and_license", result.document.canonicalText!);

    const findings = findingsOf(result);

    expect(gaps.length).toBeGreaterThan(0);
    expect(findings.slice(0, LEASE_FINDING_COUNT).every((finding) => finding.provenance === "ai_generated")).toBe(true);
    const appended = findings.slice(LEASE_FINDING_COUNT);
    expect(appended.length).toBeGreaterThan(0);
    for (const finding of appended) {
      expect(finding).toMatchObject({
        provenance: "checklist",
        category: "missing_clause",
        quote: null,
        verification: null,
        lensExplanations: [],
        modelUsed: "none",
      });
      expect(finding.id).toMatch(UUID_V8);
    }
    expect(appended.map((finding) => finding.explanation)).toEqual(
      ["rent_escalation", "subletting", "landlord_entry"].map(checklistExplanation),
    );
  });

  it("does not repeat a gap the model already reported as missing, and lists it when the model did not", async () => {
    // leaseOutput()'s own missing_clause: "No clause on who pays stamp duty and registration".
    const reported = checklistFindings(await analyzeLease(leaseOutput().findings));
    const unreported = checklistFindings(
      await analyzeLease([leaseFinding("obligation", LEASE.licenseFee, "Fee")], "\nSigned in duplicate.\n"),
    );

    const stampDuty = checklistExplanation("registration_and_stamp_duty");
    expect(reported.map((finding) => finding.explanation)).not.toContain(stampDuty);
    expect(unreported.map((finding) => finding.explanation)).toContain(stampDuty);
  });

  it("is computed on read, never stored, with an id that is stable across reads and unique per document and item", async () => {
    const first = await analyzeLease(leaseOutput().findings);
    const second = await analyzeLease(leaseOutput().findings);
    const llm = new FakeLlmClient();

    const reread = checklistFindings(await get(h.deps(llm), guestA, first.document.id));

    expect(await h.counts()).toMatchObject({ findings: 2 * LEASE_FINDING_COUNT });
    expect(reread.map((finding) => finding.id)).toEqual(checklistFindings(first).map((finding) => finding.id));
    const ids = [...checklistFindings(first), ...checklistFindings(second)].map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(llm.callCount).toBe(0);
  });

  it("adds nothing for a native_document transcription, though the same text typed in would have gaps", async () => {
    const transcription = (await readFile(path.join(FIXTURES_DIR, "leave_and_license.txt"), "utf8")).trim();
    const llm = new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      responses: [{ data: { text: transcription } }, { data: { findings: [leaseFinding("obligation", LEASE.licenseFee, "Fee")] } }],
    });

    const result = await analyze(h.deps(llm), guestA, await h.upload(guestA, "scanned_no_text_layer.pdf", MIME.pdf));

    expect(result.document.inputMode).toBe("native_document");
    expect(result.document.documentType).toBe("leave_and_license");
    expect(findMissingStandardClauses("leave_and_license", result.document.canonicalText!).length).toBeGreaterThan(0);
    expect(checklistFindings(result)).toEqual([]);
    expect(findingsOf(result)).toHaveLength(1);
  });

  it("adds nothing for a document type with no checklist", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: { findings: [] } }] });

    const result = await analyze(h.deps(llm), guestA, await h.upload(guestA, "generic.txt", MIME.txt));

    expect(result.document.documentType).toBe("generic");
    expect(findingsOf(result)).toEqual([]);
  });
});
