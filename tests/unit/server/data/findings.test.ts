// findings.ts is the only writer of findings; these tests pin its contract: a status is persisted
// only from a VerifyResult issued for exactly that quote against exactly that document's text and
// input mode. Cross-principal cases live in findings.idor.test.ts.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { verify, verifyMany, VERIFIER_VERSION, type VerifyResult } from "@/server/deterministic/verify";
import { findLatestAnalysis, insertAnalysisIfAbsent } from "@/server/data/analyses";
import type { Document } from "@/server/data/documents";
import { insertFindings, listFindings } from "@/server/data/findings";
import { createRepoTestDb, guestA, pendingDocument, readyDocument, SAMPLE_QUOTE, SAMPLE_TEXT } from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

async function analysisFor(document: Document): Promise<string> {
  const analysis =
    (await insertAnalysisIfAbsent(t.db, guestA, { documentId: document.id, promptVersion: "p", modelUsed: "m" })) ??
    (await findLatestAnalysis(t.db, guestA, document.id));
  return analysis!.id;
}

function verified(quote: string, document: Document): VerifyResult {
  return verify({ quote, canonicalText: document.canonicalText!, inputMode: document.inputMode! });
}

async function write(document: Document, finding: Parameters<typeof insertFindings>[2]["findings"][number]) {
  return insertFindings(t.db, guestA, {
    documentId: document.id,
    analysisId: await analysisFor(document),
    modelUsed: "m",
    findings: [finding],
  });
}

describe("insertFindings — positive", () => {
  it("persists status, spans and verifier_version from the VerifyResult alone", async () => {
    const document = await readyDocument(t, guestA);
    const result = verified(SAMPLE_QUOTE, document);
    expect(result.status).toBe("verified");

    const [row] = await write(document, { category: "obligation", quote: SAMPLE_QUOTE, explanation: "e", verification: result });
    expect(row).toMatchObject({
      quoteText: SAMPLE_QUOTE,
      verificationStatus: "verified",
      quoteSpanStart: result.spanStart,
      quoteSpanEnd: result.spanEnd,
      verifierVersion: VERIFIER_VERSION,
      modelUsed: "m",
    });
    expect(document.canonicalText!.slice(row.quoteSpanStart!, row.quoteSpanEnd!)).toBe(SAMPLE_QUOTE);
  });

  it("a finding with no quote is stored with no status at all", async () => {
    const document = await readyDocument(t, guestA);
    const [row] = await write(document, { category: "missing_clause", quote: null, explanation: "e", verification: null });
    expect([row.quoteText, row.verificationStatus, row.quoteSpanStart, row.verifierVersion]).toEqual([null, null, null, null]);
  });

  it("a native_document finding is stored with verify()'s capped status", async () => {
    const document = await readyDocument(t, guestA, SAMPLE_TEXT, "native_document");
    const [row] = await write(document, { category: "obligation", quote: SAMPLE_QUOTE, explanation: "e", verification: verified(SAMPLE_QUOTE, document) });
    expect(row.verificationStatus).toBe("approximate");
  });

  it("returns rows in input order and lists them in that order", async () => {
    const document = await readyDocument(t, guestA);
    const quotes = [SAMPLE_QUOTE, "monthly license fee", "not in the document at all"];
    const results = verifyMany(quotes, document.canonicalText!, "text");
    const analysisId = await analysisFor(document);
    const rows = await insertFindings(t.db, guestA, {
      documentId: document.id,
      analysisId,
      modelUsed: "m",
      findings: quotes.map((quote, i) => ({ category: "obligation", quote, explanation: `e${i}`, verification: results[i] })),
    });
    expect(rows.map((row) => row.quoteText)).toEqual(quotes);
    expect(rows.map((row) => row.verificationStatus)).toEqual(["verified", "verified", "not_found"]);
    expect((await listFindings(t.db, guestA, document.id, analysisId)).map((row) => row.explanation)).toEqual(["e0", "e1", "e2"]);
    expect(await listFindings(t.db, guestA, document.id, "not-a-uuid")).toEqual([]);
  });
});

describe("insertFindings — a status that did not come from verify() for this quote and document is refused", () => {
  it("a VerifyResult for a different quote", async () => {
    const document = await readyDocument(t, guestA);
    const other = verified("monthly license fee", document);
    await expect(
      write(document, { category: "obligation", quote: SAMPLE_QUOTE, explanation: "e", verification: other }),
    ).rejects.toThrow(/different quote or document/);
    expect(await t.db.select().from(schema.findings)).toHaveLength(0);
  });

  it("a VerifyResult computed against a different document's text", async () => {
    const document = await readyDocument(t, guestA);
    const elsewhere = verify({ quote: SAMPLE_QUOTE, canonicalText: `${SAMPLE_TEXT}\n3. Extra clause.`, inputMode: "text" });
    expect(elsewhere.status).toBe("verified");
    await expect(
      write(document, { category: "obligation", quote: SAMPLE_QUOTE, explanation: "e", verification: elsewhere }),
    ).rejects.toThrow(/different quote or document/);
    expect(await t.db.select().from(schema.findings)).toHaveLength(0);
  });

  it("a 'verified' result for a native_document computed with the wrong input mode", async () => {
    const document = await readyDocument(t, guestA, SAMPLE_TEXT, "native_document");
    const wrongMode = verify({ quote: SAMPLE_QUOTE, canonicalText: document.canonicalText!, inputMode: "text" });
    expect(wrongMode.status).toBe("verified");
    await expect(
      write(document, { category: "obligation", quote: SAMPLE_QUOTE, explanation: "e", verification: wrongMode }),
    ).rejects.toThrow(/different quote or document/);
    expect(await t.db.select().from(schema.findings)).toHaveLength(0);
  });

  it("a forged or copied result object, or none at all", async () => {
    const document = await readyDocument(t, guestA);
    const real = verified(SAMPLE_QUOTE, document);
    const forged = {
      status: "verified",
      spanStart: 0,
      spanEnd: 5,
      quote: SAMPLE_QUOTE,
      canonicalTextHash: document.canonicalTextHash,
      inputMode: "text",
      verifierVersion: VERIFIER_VERSION,
    } as unknown as VerifyResult;
    const copied = { ...real } as VerifyResult;
    for (const verification of [forged, copied, null]) {
      await expect(
        write(document, { category: "obligation", quote: SAMPLE_QUOTE, explanation: "e", verification }),
      ).rejects.toThrow(/Not a VerifyResult/);
    }
    expect(await t.db.select().from(schema.findings)).toHaveLength(0);
  });

  it("a quote-less finding carrying a result", async () => {
    const document = await readyDocument(t, guestA);
    await expect(
      write(document, { category: "obligation", quote: null, explanation: "e", verification: verified(SAMPLE_QUOTE, document) }),
    ).rejects.toThrow(/without a quote/);
  });

  it("a missing_clause finding that carries a quote — even with a genuine VerifyResult for it", async () => {
    const document = await readyDocument(t, guestA);
    await expect(
      write(document, {
        category: "missing_clause",
        quote: SAMPLE_QUOTE,
        explanation: "e",
        verification: verified(SAMPLE_QUOTE, document),
      }),
    ).rejects.toThrow(/missing_clause finding cannot quote/);
    expect(await t.db.select().from(schema.findings)).toHaveLength(0);
  });

  it("a document that has not been extracted, or whose input mode is missing", async () => {
    const pending = await pendingDocument(t, guestA);
    const finding = { category: "obligation" as const, quote: SAMPLE_QUOTE, explanation: "e", verification: null };
    await expect(
      insertFindings(t.db, guestA, {
        documentId: pending.id,
        analysisId: "00000000-0000-4000-8000-000000000000",
        modelUsed: "m",
        findings: [finding],
      }),
    ).rejects.toThrow(/extracted document/);

    // A pending row with a hash but no input_mode (the ready CHECK cannot catch a pending row):
    // refused, never defaulted to "text".
    await t.db.update(schema.documents).set({ canonicalTextHash: "h" }).where(eq(schema.documents.id, pending.id));
    await expect(
      insertFindings(t.db, guestA, {
        documentId: pending.id,
        analysisId: "00000000-0000-4000-8000-000000000000",
        modelUsed: "m",
        findings: [finding],
      }),
    ).rejects.toThrow(/extracted document/);
  });
});
