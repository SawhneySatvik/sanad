// One Guarantee tests for the Understand surface: a positive and a negative test for every guarantee
// this service touches — model payload, model fallback, errors, cache, span binding, persistence,
// native documents. Streaming, orchestrator and general mode/drafts have no Understand code path.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { AppError } from "@/server/core/errors";
import { analysisCacheKey } from "@/server/data/analyses";
import { extractDocument } from "@/server/deterministic/extract";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { FallbackLlmClient } from "@/server/llm/fallback";
import { assertSafeResponseSchema } from "@/server/llm/schema-guard";
import { PROMPT_VERSION } from "@/server/prompts/understand/analyze";
import { analyze, analyzeDocument, get, type UnderstandResult } from "@/server/services/understand";
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
  lensExplanationsFor,
  MIME,
  TEST_MODEL_ID,
} from "@tests/support/services/understand";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

function findingFor(result: UnderstandResult, quote: string) {
  const finding = findingsOf(result).find((f) => f.quote === quote);
  if (!finding) throw new Error(`no finding for quote ${quote}`);
  return finding;
}

async function storedRow(quote: string) {
  const [row] = await h.t.db.select().from(schema.findings).where(eq(schema.findings.quoteText, quote));
  return row;
}

async function analyzeLease(llm: FakeLlmClient | FallbackLlmClient): Promise<UnderstandResult> {
  return analyze(h.deps(llm), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt));
}

// The messages of a rejection and its cause chain (drizzle wraps the Postgres error).
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(" | ");
  }
  throw new Error("expected a rejection");
}

describe("the model cannot self-certify (no status/span in the response schema)", () => {
  const selfCertified = (quote: string) => ({
    ...leaseFinding("obligation", quote, "Self-certified"),
    status: "verified",
    verified: true,
    verificationStatus: "verified",
    quote_span_start: 0,
    quote_span_end: 12,
  });

  it("negative: a fabricated quote the model marks verified, with its own spans, is stored and returned not_found", async () => {
    const llm = new FakeLlmClient({
      responses: [{ data: { status: "verified", findings: [selfCertified(LEASE.fabricated), selfCertified(LEASE.licenseFee)] } }],
    });
    const result = await analyzeLease(llm);

    const fabricated = findingFor(result, LEASE.fabricated);
    expect(fabricated.verification?.status).toBe("not_found");
    expect(fabricated.verification?.spanStart).toBeNull();
    expect(await storedRow(LEASE.fabricated)).toMatchObject({
      verificationStatus: "not_found",
      quoteSpanStart: null,
      quoteSpanEnd: null,
    });

    // The model's extra fields never reach storage — not even the raw cache.
    const [cacheRow] = await h.t.db.select().from(schema.analyzedResultCache);
    expect(cacheRow.rawModelOutput).not.toMatch(/status|verified|quote_span|verificationStatus/i);
    // And the schema the model was given carries none of them.
    expect(() => assertSafeResponseSchema(llm.calls[0].schema)).not.toThrow();
  });

  it("positive: a real quote is verified — by verify(), with server spans, not the model's 0..12", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: { findings: [selfCertified(LEASE.licenseFee)] } }] });
    const result = await analyzeLease(llm);
    const fee = findingFor(result, LEASE.licenseFee);
    expect(fee.verification?.status).toBe("verified");
    expect(fee.verification?.spanStart).not.toBe(0);
    expect(result.document.canonicalText!.slice(fee.verification!.spanStart!, fee.verification!.spanEnd!)).toBe(LEASE.licenseFee);
  });
});

describe("model fallback runs the same verify() path and records the model", () => {
  function fallbackClient() {
    const primary = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "primary down") }] });
    const secondary = new FakeLlmClient({ modelUsed: "fake-gemma", responses: [{ data: leaseOutput() }] });
    return new FallbackLlmClient(primary, secondary);
  }

  it("positive: a real quote answered by the fallback model is verified, and the fallback model is persisted", async () => {
    const result = await analyzeLease(fallbackClient());
    expect(result.analysis!.modelUsed).toBe("fake-gemma");
    expect(findingFor(result, LEASE.licenseFee).verification?.status).toBe("verified");
    expect(findingFor(result, LEASE.licenseFee).modelUsed).toBe("fake-gemma");
    expect((await storedRow(LEASE.licenseFee)).modelUsed).toBe("fake-gemma");
  });

  it("negative: a fabricated quote from the fallback model is not_found, and its output is never served to a primary-model lookup", async () => {
    const result = await analyzeLease(fallbackClient());
    expect(findingFor(result, LEASE.fabricated).verification?.status).toBe("not_found");

    const primaryAgain = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
    await analyzeLease(primaryAgain);
    expect(primaryAgain.callCount).toBe(1);
  });
});

describe("errors never return content and never persist a partial analysis", () => {
  it("negative: a provider failure after extraction is a typed error with zero analyses, findings, lens rows or cache", async () => {
    const llm = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "down") }] });
    await expect(analyzeLease(llm)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(await h.counts()).toMatchObject({ documents: 1, analyses: 0, findings: 0, lenses: 0, cache: 0 });
    const [document] = await h.t.db.select().from(schema.documents);
    expect(document.processingStatus).toBe("ready");
  });

  it("negative: malformed model output (twice, past the repair retry) is SCHEMA_FAILED with nothing persisted", async () => {
    const llm = new FakeLlmClient({ responses: [{ rawText: "not json" }, { rawText: '{"findings":"nope"}' }] });
    await expect(analyzeLease(llm)).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    expect(await h.counts()).toMatchObject({ analyses: 0, findings: 0, lenses: 0, cache: 0 });
  });

  it("negative: a failure inside the persist transaction (last insert) rolls back every row it wrote", async () => {
    await h.t.client.exec("ALTER TABLE finding_lens_explanations ADD CONSTRAINT test_reject_every_row CHECK (false)");
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    expect(await rejectionText(analyzeLease(llm))).toMatch(/test_reject_every_row/);
    expect(await h.counts()).toMatchObject({ analyses: 0, findings: 0, lenses: 0, cache: 0 });
  });

  it("positive: once the failure clears, the same document analyses normally", async () => {
    await h.t.client.exec("ALTER TABLE finding_lens_explanations ADD CONSTRAINT test_reject_every_row CHECK (false)");
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    expect(await rejectionText(analyzeLease(llm))).toMatch(/test_reject_every_row/);
    await h.t.client.exec("ALTER TABLE finding_lens_explanations DROP CONSTRAINT test_reject_every_row");

    const [document] = await h.t.db.select().from(schema.documents);
    const result = await analyzeDocument(h.deps(llm), guestA, document.id);
    expect(findingFor(result, LEASE.licenseFee).verification?.status).toBe("verified");
    expect(await h.counts()).toMatchObject({ analyses: 1, findings: LEASE_FINDING_COUNT });
  });
});

describe("a cache hit is only a skipped LLM call; statuses are re-verified", () => {
  async function seedCache(rawModelOutput: string, expiresAt = new Date(Date.now() + 3_600_000)) {
    const text = await readFile(path.join(FIXTURES_DIR, "leave_and_license.txt"), "utf8");
    const extracted = await extractDocument({ pastedText: text });
    if (extracted.kind !== "extracted") throw new Error("fixture did not extract");
    const cacheKey = analysisCacheKey({
      canonicalTextHash: extracted.canonicalTextHash,
      documentType: "leave_and_license",
      jurisdiction: "IN",
      promptVersion: PROMPT_VERSION,
      modelId: TEST_MODEL_ID,
    });
    await h.t.db.insert(schema.analyzedResultCache).values({ cacheKey, rawModelOutput, modelUsed: TEST_MODEL_ID, expiresAt });
  }

  it("negative: a cached fabricated quote — even one carrying status 'verified' — returns not_found, with no LLM call", async () => {
    await seedCache(
      JSON.stringify({
        findings: [
          { ...leaseFinding("penalty", LEASE.fabricated, "Late fee"), status: "verified", quote_span_start: 0, quote_span_end: 9 },
          leaseFinding("obligation", LEASE.licenseFee, "Fee"),
        ],
      }),
    );
    const llm = new FakeLlmClient();
    const result = await analyzeLease(llm);

    expect(llm.callCount).toBe(0);
    expect(findingFor(result, LEASE.fabricated).verification?.status).toBe("not_found");
    expect((await storedRow(LEASE.fabricated)).verificationStatus).toBe("not_found");
  });

  it("positive: a cached real quote is verified against the new document's own text", async () => {
    await seedCache(JSON.stringify({ findings: [leaseFinding("obligation", LEASE.licenseFee, "Fee")] }));
    const llm = new FakeLlmClient();
    const result = await analyzeLease(llm);
    const fee = findingFor(result, LEASE.licenseFee);
    expect(llm.callCount).toBe(0);
    expect(fee.verification?.status).toBe("verified");
    expect(fee.verification?.canonicalTextHash).toBe(result.document.canonicalTextHash);
  });

  it("an expired or unparseable cache entry is a miss: the LLM is called", async () => {
    await seedCache(JSON.stringify({ findings: [] }), new Date(Date.now() - 1000));
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    await analyzeLease(llm);
    expect(llm.callCount).toBe(1);

    await h.t.db.update(schema.analyzedResultCache).set({ rawModelOutput: "{not json", expiresAt: new Date(Date.now() + 3_600_000) });
    await analyzeLease(llm);
    expect(llm.callCount).toBe(2);
  });
});

describe("spans are verify()'s offsets into the returned canonical_text", () => {
  it("positive: each verified span slices the canonical text to the quoted passage (line breaks included)", async () => {
    const result = await analyzeLease(new FakeLlmClient({ responses: [{ data: leaseOutput() }] }));
    const text = result.document.canonicalText!;

    const fee = findingFor(result, LEASE.licenseFee).verification!;
    expect(text.slice(fee.spanStart!, fee.spanEnd!)).toBe(LEASE.licenseFee);

    // The quote has a space where the document has a line break: the span covers the document's
    // own text, which is what gets highlighted.
    const deductions = findingFor(result, LEASE.deductions).verification!;
    const slice = text.slice(deductions.spanStart!, deductions.spanEnd!);
    expect(deductions.status).toBe("verified");
    expect(slice).toContain("\n");
    expect(slice.replace(/\s+/g, " ")).toBe(LEASE.deductions);
  });

  it("negative: an unverifiable quote has no span to highlight", async () => {
    const result = await analyzeLease(new FakeLlmClient({ responses: [{ data: leaseOutput() }] }));
    const fabricated = findingFor(result, LEASE.fabricated).verification!;
    expect([fabricated.status, fabricated.spanStart, fabricated.spanEnd]).toEqual(["not_found", null, null]);
  });
});

describe("stored statuses are audit only; get() re-verifies every quote", () => {
  it("negative: a fabricated quote tampered to 'verified' in the database is returned not_found", async () => {
    const analysed = await analyzeLease(new FakeLlmClient({ responses: [{ data: leaseOutput() }] }));
    await h.t.db
      .update(schema.findings)
      .set({ verificationStatus: "verified", quoteSpanStart: 0, quoteSpanEnd: 20 })
      .where(eq(schema.findings.quoteText, LEASE.fabricated));
    expect((await storedRow(LEASE.fabricated)).verificationStatus).toBe("verified");

    const result = await get(h.deps(new FakeLlmClient()), guestA, analysed.document.id);
    const fabricated = findingFor(result, LEASE.fabricated).verification!;
    expect([fabricated.status, fabricated.spanStart, fabricated.spanEnd]).toEqual(["not_found", null, null]);
  });

  it("positive: a real quote tampered to not_found with wrong spans is returned verified with the true spans", async () => {
    const analysed = await analyzeLease(new FakeLlmClient({ responses: [{ data: leaseOutput() }] }));
    const truth = findingFor(analysed, LEASE.lockIn).verification!;
    await h.t.db
      .update(schema.findings)
      .set({ verificationStatus: "not_found", quoteSpanStart: null, quoteSpanEnd: null })
      .where(eq(schema.findings.quoteText, LEASE.lockIn));
    await h.t.db
      .update(schema.findings)
      .set({ quoteSpanStart: 1, quoteSpanEnd: 2 })
      .where(eq(schema.findings.quoteText, LEASE.licenseFee));

    const result = await get(h.deps(new FakeLlmClient()), guestA, analysed.document.id);
    const lockIn = findingFor(result, LEASE.lockIn).verification!;
    expect([lockIn.status, lockIn.spanStart, lockIn.spanEnd]).toEqual(["verified", truth.spanStart, truth.spanEnd]);
    const fee = findingFor(result, LEASE.licenseFee).verification!;
    expect(result.document.canonicalText!.slice(fee.spanStart!, fee.spanEnd!)).toBe(LEASE.licenseFee);
  });
});

describe("a native_document transcription can never be verified", () => {
  const transcription =
    "LEAVE AND LICENSE AGREEMENT\nThe Licensee shall pay a monthly license fee of Rs. 20,000/- on or before the 5th day of every month.";
  const transcribedQuote = "The Licensee shall pay a monthly license fee of Rs. 20,000/-";

  function nativeLlm() {
    return new FakeLlmClient({
      capabilities: { nativeDocumentInput: true },
      responses: [
        { data: { text: transcription } },
        {
          data: {
            findings: [
              leaseFinding("obligation", transcribedQuote, "Fee"),
              leaseFinding("penalty", LEASE.fabricated, "Late fee"),
            ],
          },
        },
      ],
    });
  }

  it("negative: a quote copied exactly from the transcription is approximate at most — stored and returned", async () => {
    const result = await analyze(h.deps(nativeLlm()), guestA, await h.upload(guestA, "scanned_no_text_layer.pdf", MIME.pdf));

    expect(result.document.inputMode).toBe("native_document");
    expect(result.findings.map((f) => f.verification?.status)).toEqual(["approximate", "not_found"]);
    const stored = await h.t.db.select().from(schema.findings);
    expect(stored.map((row) => row.verificationStatus).sort()).toEqual(["approximate", "not_found"]);

    // The persistence backstop rejects a verified row for a native document outright…
    expect(
      await rejectionText(
        h.t.db
          .update(schema.findings)
          .set({ verificationStatus: "verified" })
          .where(eq(schema.findings.quoteText, transcribedQuote))
          .then(() => undefined),
      ),
    ).toMatch(/not a ready text-mode document/);
    // …and a read still re-verifies to approximate.
    const reread = await get(h.deps(new FakeLlmClient()), guestA, result.document.id);
    expect(findingsOf(reread).map((f) => f.verification?.status)).toEqual(["approximate", "not_found"]);
  });

  it("positive control: the same quote against the same text uploaded as a text document IS verified", async () => {
    const llm = new FakeLlmClient({
      responses: [{ data: { findings: [{ category: "obligation", quote: transcribedQuote, lensExplanations: lensExplanationsFor("leave_and_license", "Fee") }] } }],
    });
    const input = await h.uploadBytes(guestA, "typed.txt", MIME.txt, new TextEncoder().encode(transcription));
    const result = await analyze(h.deps(llm), guestA, input);
    expect(result.document.inputMode).toBe("text");
    expect(result.findings[0].verification?.status).toBe("verified");
  });
});
