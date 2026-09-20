import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import * as schema from "@/db/schema";
import { AppError } from "@/server/core/errors";
import { ANALYSIS_CACHE_TTL_SECONDS } from "@/server/data/analyses";
import { createPendingDocument, DOCUMENT_GUEST_TTL_SECONDS, getDocument } from "@/server/data/documents";
import { insertFindings } from "@/server/data/findings";
import { MAX_QUOTES_PER_CALL, verifyMany } from "@/server/deterministic/verify";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import type { LlmClient, LlmCompleteInput, LlmCompleteResult, LlmStreamEvent } from "@/server/llm/types";
import { LLM_TIMEOUT_MS } from "@/server/llm/timeouts";
import { MAX_FINDINGS, PROMPT_VERSION, THINKING_BUDGET } from "@/server/prompts/understand/analyze";
import { LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";
import {
  analyze,
  analyzeDocument,
  assertCacheModelId,
  DocumentAnalysisError,
  get,
  type UnderstandResult,
} from "@/server/services/understand";
import {
  createHarness,
  findingsOf,
  guestA,
  type Harness,
  LEASE,
  LEASE_FINDING_COUNT,
  leaseFinding,
  leaseOutput,
  MIME,
  TEST_MODEL_ID,
  USER_A_ID,
  userA,
} from "@tests/support/services/understand";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

// The model's own findings; get() appends the standard-clause checklist's gaps after them.
function modelFindings(result: UnderstandResult) {
  return findingsOf(result).filter((finding) => finding.provenance === "ai_generated");
}

function statusOf(result: UnderstandResult, quote: string | null) {
  const finding = findingsOf(result).find((f) => f.quote === quote);
  if (!finding) throw new Error(`no finding for quote ${quote}`);
  return finding.verification?.status ?? null;
}

const LEASE_LENS_IDS = LENSES_BY_DOCUMENT_TYPE.leave_and_license.map((lens) => lens.id);

describe("analyze — full pipeline against a fixture", () => {
  it("persists findings with real statuses and 2-4 lens rows each, from exactly ONE LLM call", async () => {
    // defaultResponse, not a one-entry queue: an extra call would be answered, so only the
    // call-count assertion below can catch a per-lens (or any second) call.
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);

    const result = await analyze(h.deps(llm), guestA, input);

    expect(llm.callCount).toBe(1);

    const document = result.document;
    expect(document.processingStatus).toBe("ready");
    expect(document.inputMode).toBe("text");
    expect(document.documentType).toBe("leave_and_license");
    expect(document.jurisdiction).toBe("IN");
    expect(document.detectionConfidence).toMatch(/^\d\.\d\d$/);
    expect(document.extractorVersion).toBeTruthy();
    expect(document.canonicalTextHash).toBe(
      createHash("sha256").update(document.canonicalText!, "utf8").digest("hex"),
    );

    expect(statusOf(result, LEASE.licenseFee)).toBe("verified");
    expect(statusOf(result, LEASE.depositRefund)).toBe("verified");
    expect(statusOf(result, LEASE.deductions)).toBe("verified");
    expect(statusOf(result, LEASE.lockIn)).toBe("verified");
    expect(statusOf(result, LEASE.notice)).toBe("verified");
    expect(statusOf(result, LEASE.wearAndTear)).toBe("verified");
    expect(statusOf(result, LEASE.fabricated)).toBe("not_found");
    expect(statusOf(result, LEASE.nearMiss)).toBe("approximate");
    expect(statusOf(result, null)).toBeNull();

    // A verified span slices the canonical text to the quote.
    const fee = result.findings.find((f) => f.quote === LEASE.licenseFee)!;
    expect(document.canonicalText!.slice(fee.verification!.spanStart!, fee.verification!.spanEnd!)).toBe(LEASE.licenseFee);
    // extract's hash IS the hash verify() binds its result to.
    expect(fee.verification!.canonicalTextHash).toBe(document.canonicalTextHash);

    // Persisted: N findings, N x 4 lens rows (leave_and_license has 4 lenses), one analysis.
    const findingRows = await h.t.db.select().from(schema.findings);
    const lensRows = await h.t.db.select().from(schema.findingLensExplanations);
    expect(findingRows).toHaveLength(LEASE_FINDING_COUNT);
    expect(lensRows).toHaveLength(LEASE_FINDING_COUNT * LEASE_LENS_IDS.length);
    for (const finding of findingRows) {
      const lenses = lensRows.filter((row) => row.findingId === finding.id).map((row) => row.roleStageLens);
      expect(lenses.length).toBeGreaterThanOrEqual(2);
      expect(lenses.length).toBeLessThanOrEqual(4);
      expect(lenses).toEqual(LEASE_LENS_IDS);
    }
    expect(await h.counts()).toMatchObject({ documents: 1, analyses: 1, findings: 9, lenses: 36, cache: 1 });

    const [analysisRow] = await h.t.db.select().from(schema.analyses);
    expect(analysisRow).toMatchObject({ documentId: document.id, promptVersion: PROMPT_VERSION, modelUsed: TEST_MODEL_ID });
    expect(result.analysis?.id).toBe(analysisRow.id);
    expect(modelFindings(result)).toHaveLength(LEASE_FINDING_COUNT);
    expect(modelFindings(result).every((f) => f.modelUsed === TEST_MODEL_ID)).toBe(true);

    // Returned lens explanations: every lens, default explanation = first lens's.
    for (const finding of modelFindings(result)) {
      expect(finding.lensExplanations.map((lens) => lens.lens)).toEqual(LEASE_LENS_IDS);
      expect(finding.explanation).toBe(finding.lensExplanations[0].explanation);
    }
  });

  it("sends the document as delimited data with every lens in the prompt, never passing raw document parts", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
    const result = await analyze(h.deps(llm), guestA, input);

    const call = llm.calls[0];
    const boundary = `DOCUMENT-${result.document.canonicalTextHash!.slice(0, 16)}`;
    expect(call.userPrompt).toContain(`<<<${boundary} BEGIN>>>\n${result.document.canonicalText}\n<<<${boundary} END>>>`);
    expect(call.documents).toBeUndefined();
    for (const lensId of LEASE_LENS_IDS) expect(call.systemPrompt).toContain(lensId);
  });

  it("extracts a PDF upload server-side and verifies quotes against the extracted text", async () => {
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            findings: [
              leaseFinding("obligation", LEASE.licenseFee, "Fee"),
              leaseFinding("deadline", LEASE.depositRefund, "Refund"),
              leaseFinding("penalty", LEASE.fabricated, "Late fee"),
            ],
          },
        },
      ],
    });
    const input = await h.upload(userA, "leave_and_license.pdf", MIME.pdf);
    const result = await analyze(h.deps(llm), userA, input);

    expect(result.document.documentType).toBe("leave_and_license");
    expect(statusOf(result, LEASE.licenseFee)).toBe("verified");
    expect(statusOf(result, LEASE.depositRefund)).toBe("verified");
    expect(statusOf(result, LEASE.fabricated)).toBe("not_found");
  });

  it("drops a quote the model attached to a missing_clause finding (it has no text to verify) and treats a blank quote as none", async () => {
    const llm = new FakeLlmClient({
      responses: [
        {
          data: {
            findings: [
              leaseFinding("missing_clause", LEASE.licenseFee, "Missing escalation clause"),
              leaseFinding("ambiguity", "   ", "Blank quote"),
            ],
          },
        },
      ],
    });
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
    const result = await analyze(h.deps(llm), guestA, input);

    expect(modelFindings(result).map((f) => [f.quote, f.verification])).toEqual([
      [null, null],
      [null, null],
    ]);
    const rows = await h.t.db.select().from(schema.findings);
    expect(rows.map((row) => [row.quoteText, row.verificationStatus, row.quoteSpanStart])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
  });
});

describe("an over-long model response is trimmed, never failed", () => {
  it(`keeps the first MAX_FINDINGS (${MAX_FINDINGS}) distinct findings, exact repeats dropped first, from ONE call with no repair retry`, async () => {
    // missing_clause findings last, where models usually put them — so the cap cuts them.
    const distinct = [
      ...Array.from({ length: MAX_FINDINGS + 3 }, (_, i) => leaseFinding("obligation", LEASE.lockIn, `Finding ${i}`)),
      ...[0, 1].map((i) => leaseFinding("missing_clause", null, `Missing ${i}`)),
    ];
    // Five exact repeats of the first finding: without de-duplication they would take five of the slots.
    const findings = [distinct[0], ...Array.from({ length: 5 }, () => distinct[0]), ...distinct.slice(1)];
    // One queued response: a repair retry would find the queue empty and throw.
    const llm = new FakeLlmClient({ responses: [{ data: { findings } }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let result;
    try {
      result = await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));

      // One structured line with per-category counts, and never any finding text.
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.filter((line) => line.includes("llm_output_trimmed")).map((line) => JSON.parse(line))).toEqual([
        {
          event: "llm_output_trimmed",
          surface: "understand",
          documentId: result.document.id,
          modelUsed: TEST_MODEL_ID,
          received: findings.length,
          kept: MAX_FINDINGS,
          duplicate: { obligation: 5 },
          overCap: { obligation: 3, missing_clause: 2 },
        },
      ]);
      expect(lines.join("\n")).not.toContain("Finding 0");
      expect(lines.join("\n")).not.toContain(LEASE.lockIn);
    } finally {
      warn.mockRestore();
    }

    expect(llm.callCount).toBe(1);
    expect(result.findingsDropped).toEqual({ duplicate: { obligation: 5 }, overCap: { obligation: 3, missing_clause: 2 } });
    const kept = modelFindings(result);
    expect(kept).toHaveLength(MAX_FINDINGS);
    const expected = distinct.slice(0, MAX_FINDINGS).map((finding) => finding.lensExplanations[LEASE_LENS_IDS[0]]);
    expect(kept.map((finding) => finding.explanation).sort()).toEqual(expected.sort());
    expect(kept.every((finding) => finding.verification?.status === "verified")).toBe(true);
    expect(await h.counts()).toMatchObject({ analyses: 1, findings: MAX_FINDINGS, lenses: MAX_FINDINGS * LEASE_LENS_IDS.length });
    // Only the analysing call carries the counts; a later read does not.
    expect(await get(h.deps(llm), guestA, result.document.id)).not.toHaveProperty("findingsDropped");
  });

  it("the analysis call carries Understand's budget and its thinking setting (off)", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
    await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));

    expect(llm.calls[0].timeoutMs).toBe(LLM_TIMEOUT_MS.understand);
    expect(llm.calls[0].thinkingBudget).toBe(THINKING_BUDGET);
    expect(THINKING_BUDGET).toBe(0);
  });
});

describe("ownership and TTL", () => {
  it("a guest document expires with the guest TTL and its cache entry never outlives it", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
    const before = Date.now();
    const result = await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));

    expect(result.document.ownerGuestSessionId).toBe("guest-session-a");
    expect(result.document.ownerUserId).toBeNull();
    const expiresAt = result.document.expiresAt!.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + DOCUMENT_GUEST_TTL_SECONDS * 1000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + DOCUMENT_GUEST_TTL_SECONDS * 1000 + 1000);

    const [cacheRow] = await h.t.db.select().from(schema.analyzedResultCache);
    expect(cacheRow.expiresAt.getTime()).toBe(expiresAt);
  });

  it("a user document never expires; its cache entry gets the cache TTL", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
    const result = await analyze(h.deps(llm), userA, await h.upload(userA, "leave_and_license.txt", MIME.txt));

    expect(result.document.ownerUserId).toBe(USER_A_ID);
    expect(result.document.expiresAt).toBeNull();
    const [cacheRow] = await h.t.db.select().from(schema.analyzedResultCache);
    const expected = Date.now() + ANALYSIS_CACHE_TTL_SECONDS * 1000;
    expect(Math.abs(cacheRow.expiresAt.getTime() - expected)).toBeLessThan(60_000);
  });
});

describe("result cache", () => {
  it("a second upload of identical content is served from the cache: still ONE LLM call, its own analysis, statuses from verify()", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const first = await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
    const second = await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));

    expect(llm.callCount).toBe(1);
    expect(second.document.id).not.toBe(first.document.id);
    expect(second.analysis!.id).not.toBe(first.analysis!.id);
    expect(second.analysis!.documentId).toBe(second.document.id);
    expect(await h.counts()).toMatchObject({ documents: 2, analyses: 2, findings: 18, lenses: 72, cache: 1 });

    // Each status is a VerifyResult bound to the SECOND document's text — computed, not copied.
    for (const finding of second.findings.filter((f) => f.verification !== null)) {
      expect(finding.verification!.canonicalTextHash).toBe(second.document.canonicalTextHash);
      expect(finding.verification!.quote).toBe(finding.quote);
    }
    expect(statusOf(second, LEASE.licenseFee)).toBe("verified");
    expect(statusOf(second, LEASE.fabricated)).toBe("not_found");
  });

  it("the cache is keyed per model: a lookup for a different model id misses and calls the LLM", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
    await analyze({ ...h.deps(llm), modelId: "another-model" }, guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
    expect(llm.callCount).toBe(2);
  });

  it("assertCacheModelId (composition root) refuses a deps.modelId that is not the primary client's — the silent-miss case above", () => {
    expect(() => assertCacheModelId({ modelId: TEST_MODEL_ID }, TEST_MODEL_ID)).not.toThrow();
    expect(() => assertCacheModelId({ modelId: "gemini-2.5-flash" }, "gemini-2.5-pro")).toThrow(/must equal the primary/);
    expect(() => assertCacheModelId({ modelId: "" }, "")).toThrow(/must equal the primary/);
  });
});

// Holds every complete() call until `parties` calls have arrived, so concurrent analyzeDocument
// calls have all passed their "already analysed?" check before any of them persists.
class BarrierLlmClient implements LlmClient {
  readonly capabilities: LlmClient["capabilities"];
  private arrived = 0;
  private release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(
    private readonly inner: FakeLlmClient,
    private readonly parties: number,
  ) {
    this.capabilities = inner.capabilities;
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    this.arrived += 1;
    if (this.arrived === this.parties) this.release();
    await this.gate;
    return this.inner.complete(input);
  }

  stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    return this.inner.stream(input);
  }
}

describe("idempotency — UNIQUE(document_id, prompt_version, model_used)", () => {
  async function readyDocumentWithoutAnalysis(): Promise<string> {
    const failing = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "down") }] });
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
    await expect(analyze(h.deps(failing), guestA, input)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const [row] = await h.t.db.select().from(schema.documents).where(eq(schema.documents.storageRef, input.storageRef));
    expect(row.processingStatus).toBe("ready");
    return row.id;
  }

  it("two concurrent analyses of one document persist exactly one analysis and one set of findings; both return it", async () => {
    const documentId = await readyDocumentWithoutAnalysis();
    const inner = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const llm = new BarrierLlmClient(inner, 2);

    const [a, b] = await Promise.all([
      analyzeDocument(h.deps(llm), guestA, documentId),
      analyzeDocument(h.deps(llm), guestA, documentId),
    ]);

    // Both really raced: both reached the model.
    expect(inner.callCount).toBe(2);
    expect(a.analysis!.id).toBe(b.analysis!.id);
    expect(await h.counts()).toMatchObject({ analyses: 1, findings: LEASE_FINDING_COUNT, lenses: LEASE_FINDING_COUNT * 4 });
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
  });

  it("re-analysing an already analysed document returns the existing analysis without calling the model", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const first = await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
    const again = await analyzeDocument(h.deps(llm), guestA, first.document.id);

    expect(llm.callCount).toBe(1);
    expect(again.analysis!.id).toBe(first.analysis!.id);
    expect(await h.counts()).toMatchObject({ analyses: 1, findings: LEASE_FINDING_COUNT });
  });

  it("the same storage ref cannot be analysed twice (confirmUpload is one-shot) — NOT_FOUND, one document", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
    await analyze(h.deps(llm), guestA, input);
    await expect(analyze(h.deps(llm), guestA, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await h.counts()).toMatchObject({ documents: 1, analyses: 1 });
  });
});

describe("extraction branches", () => {
  it("a corrupt PDF marks the document extraction_failed and throws EXTRACTION_FAILED, with no LLM call", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const input = await h.upload(guestA, "corrupt.pdf", MIME.pdf);
    await expect(analyze(h.deps(llm), guestA, input)).rejects.toMatchObject({ code: "EXTRACTION_FAILED" });

    const [row] = await h.t.db.select().from(schema.documents);
    expect(row.processingStatus).toBe("extraction_failed");
    expect(row.canonicalText).toBeNull();
    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toMatchObject({ documents: 1, analyses: 0, findings: 0 });
  });

  it("a text upload that is not valid UTF-8 is INVALID_DOCUMENT and marked extraction_failed", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const input = await h.uploadBytes(guestA, "bad.txt", MIME.txt, Uint8Array.from([0x41, 0xff, 0xfe, 0x42]));
    await expect(analyze(h.deps(llm), guestA, input)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    const [row] = await h.t.db.select().from(schema.documents);
    expect(row.processingStatus).toBe("extraction_failed");
    expect(llm.callCount).toBe(0);
  });

  it("a scan with no text layer is transcribed by a native-document-capable model and stored as native_document", async () => {
    const transcription = "LEAVE AND LICENSE AGREEMENT\nThe Licensee shall pay a monthly license fee of Rs. 20,000/- on or before the 5th day of every month.";
    const llm = new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      responses: [
        { data: { text: transcription } },
        {
          data: {
            findings: [leaseFinding("obligation", "The Licensee shall pay a monthly license fee of Rs. 20,000/-", "Fee")],
          },
        },
      ],
    });
    const input = await h.upload(guestA, "scanned_no_text_layer.pdf", MIME.pdf);
    const result = await analyze(h.deps(llm), guestA, input);

    expect(llm.callCount).toBe(2);
    expect(llm.calls[0].documents?.[0].nativeFile?.mimeType).toBe(MIME.pdf);
    expect(result.document.inputMode).toBe("native_document");
    expect(result.document.canonicalText).toBe(transcription);
    expect(result.document.extractorVersion).toBe(`native-transcription/transcribe-v1/${TEST_MODEL_ID}`);
    expect(result.findings[0].verification?.status).toBe("approximate");
  });

  it("a scan with no text layer and a model without native input is INVALID_DOCUMENT, extraction_failed, zero LLM calls", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: { text: "x" } } });
    const input = await h.upload(guestA, "scanned_no_text_layer.pdf", MIME.pdf);
    await expect(analyze(h.deps(llm), guestA, input)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    const [row] = await h.t.db.select().from(schema.documents);
    expect(row.processingStatus).toBe("extraction_failed");
    expect(llm.callCount).toBe(0);
  });

  it("analyzeDocument on an extraction_failed document is EXTRACTION_FAILED, with no retry of the extraction and no LLM call", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const input = await h.upload(guestA, "corrupt.pdf", MIME.pdf);
    await expect(analyze(h.deps(llm), guestA, input)).rejects.toBeInstanceOf(AppError);
    const [row] = await h.t.db.select().from(schema.documents);
    await expect(analyzeDocument(h.deps(llm), guestA, row.id)).rejects.toMatchObject({ code: "EXTRACTION_FAILED" });
    expect(llm.callCount).toBe(0);
  });
});

const SCAN_TRANSCRIPTION =
  "LEAVE AND LICENSE AGREEMENT\nThe Licensee shall pay a monthly license fee of Rs. 20,000/- on or before the 5th day of every month.";
const SCAN_ANALYSIS = {
  findings: [leaseFinding("obligation", "The Licensee shall pay a monthly license fee of Rs. 20,000/-", "Fee")],
};

// What the client receives when analyze() fails after its document row exists — the only way it
// learns the id it retries with.
async function failedAnalysis(promise: Promise<unknown>): Promise<DocumentAnalysisError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DocumentAnalysisError) return error;
    throw error;
  }
  throw new Error("expected analyze() to fail");
}

describe("retry — analyzeDocument resumes whatever stage is incomplete", () => {
  it("an analysis LLM failure leaves the document not_analyzed (findings null, never []); analyzeDocument then completes it", async () => {
    const failing = new FakeLlmClient({ responses: [{ error: new AppError("TIMEOUT", "slow") }] });
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
    const error = await failedAnalysis(analyze(h.deps(failing), guestA, input));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("TIMEOUT");
    const [row] = await h.t.db.select().from(schema.documents);
    expect([error.documentId, row.processingStatus]).toEqual([row.id, "ready"]);

    const before = await get(h.deps(failing), guestA, error.documentId);
    expect(before.analysisState).toBe("not_analyzed");
    expect(before.findings).toBeNull();
    expect(before.analysis).toBeNull();

    const llm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
    const retried = await analyzeDocument(h.deps(llm), guestA, error.documentId);
    expect(retried.analysisState).toBe("complete");
    expect(llm.callCount).toBe(1);

    const after = await get(h.deps(llm), guestA, error.documentId);
    expect(after.analysisState).toBe("complete");
    expect(modelFindings(after)).toHaveLength(LEASE_FINDING_COUNT);
    expect(statusOf(after, LEASE.licenseFee)).toBe("verified");
  });

  it("an analysed document with no issues is complete with findings [] — distinct from not_analyzed", async () => {
    // A generic document has no standard-clause checklist, so nothing is added to the model's [].
    const llm = new FakeLlmClient({ responses: [{ data: { findings: [] } }] });
    const result = await analyze(h.deps(llm), guestA, await h.upload(guestA, "generic.txt", MIME.txt));
    const read = await get(h.deps(llm), guestA, result.document.id);
    expect([read.analysisState, read.findings]).toEqual(["complete", []]);
  });

  it.each([
    ["RATE_LIMITED", new AppError("RATE_LIMITED", "slow down", { retryAfterSeconds: 7 })],
    ["TIMEOUT", new AppError("TIMEOUT", "too slow")],
    ["UPSTREAM_UNAVAILABLE", new AppError("UPSTREAM_UNAVAILABLE", "down")],
  ])("a %s while transcribing a scan surfaces, leaves the document pending, and analyzeDocument retries it", async (code, providerError) => {
    const failing = new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, responses: [{ error: providerError }] });
    const input = await h.upload(guestA, "scanned_no_text_layer.pdf", MIME.pdf);
    const error = await failedAnalysis(analyze(h.deps(failing), guestA, input));
    expect([error.code, error.retryAfterSeconds]).toEqual([code, providerError.retryAfterSeconds]);

    const [row] = await h.t.db.select().from(schema.documents);
    expect([error.documentId, row.processingStatus]).toEqual([row.id, "pending"]);
    const read = await get(h.deps(failing), guestA, error.documentId);
    expect([read.analysisState, read.findings]).toEqual(["not_analyzed", null]);

    const llm = new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      responses: [{ data: { text: SCAN_TRANSCRIPTION } }, { data: SCAN_ANALYSIS }],
    });
    const retried = await analyzeDocument(h.deps(llm), guestA, error.documentId);
    expect(llm.callCount).toBe(2);
    expect(retried.document).toMatchObject({ processingStatus: "ready", inputMode: "native_document", canonicalText: SCAN_TRANSCRIPTION });
    expect(findingsOf(retried)[0].verification?.status).toBe("approximate");
  });

  it("a transcription with no text is a genuine failure: extraction_failed, and a retry is EXTRACTION_FAILED with no model call", async () => {
    const llm = new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, responses: [{ data: { text: "  \n  " } }] });
    const input = await h.upload(guestA, "scanned_no_text_layer.pdf", MIME.pdf);
    await expect(analyze(h.deps(llm), guestA, input)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });

    const [row] = await h.t.db.select().from(schema.documents);
    expect(row.processingStatus).toBe("extraction_failed");
    const retry = new FakeLlmClient({ capabilities: { nativeDocumentInput: true }, defaultResponse: { data: { text: "x" } } });
    await expect(analyzeDocument(h.deps(retry), guestA, row.id)).rejects.toMatchObject({ code: "EXTRACTION_FAILED" });
    expect(retry.callCount).toBe(0);
  });

  it("two concurrent retries of a pending document both extract; one wins, both return the one analysis", async () => {
    const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
    const pending = await createPendingDocument(h.t.db, guestA, input);
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });

    const [a, b] = await Promise.all([
      analyzeDocument(h.deps(llm), guestA, pending.id),
      analyzeDocument(h.deps(llm), guestA, pending.id),
    ]);
    expect(a.analysis.id).toBe(b.analysis.id);
    expect(await h.counts()).toMatchObject({ documents: 1, analyses: 1, findings: LEASE_FINDING_COUNT });
  });
});

describe("get", () => {

  it(`re-verifies more than MAX_QUOTES_PER_CALL (${MAX_QUOTES_PER_CALL}) findings in chunks`, async () => {
    const llm = new FakeLlmClient({ responses: [{ data: { findings: [] } }] });
    const analysed = await analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
    const document = await getDocument(h.t.db, guestA, analysed.document.id);
    const quotes = Array.from({ length: MAX_QUOTES_PER_CALL + 10 }, (_, i) => (i % 2 === 0 ? LEASE.lockIn : `${LEASE.fabricated} ${i}`));
    const results = [
      ...verifyMany(quotes.slice(0, MAX_QUOTES_PER_CALL), document.canonicalText!, "text"),
      ...verifyMany(quotes.slice(MAX_QUOTES_PER_CALL), document.canonicalText!, "text"),
    ];
    await insertFindings(h.t.db, guestA, {
      documentId: document.id,
      analysisId: analysed.analysis!.id,
      modelUsed: TEST_MODEL_ID,
      findings: quotes.map((quote, i) => ({ category: "obligation", quote, explanation: "e", verification: results[i] })),
    });

    const result = modelFindings(await get(h.deps(llm), guestA, document.id));
    expect(result).toHaveLength(MAX_QUOTES_PER_CALL + 10);
    expect(result.map((f) => f.verification?.status)).toEqual(
      quotes.map((_, i) => (i % 2 === 0 ? "verified" : "not_found")),
    );
  });
});
