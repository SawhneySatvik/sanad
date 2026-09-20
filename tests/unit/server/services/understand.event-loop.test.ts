import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findMissingStandardClauses } from "@/server/deterministic/standard-clauses";
import { MAX_QUOTES_PER_CALL, verifyMany, type VerifyResult } from "@/server/deterministic/verify";
import { insertAnalysisIfAbsent } from "@/server/data/analyses";
import { insertFindings } from "@/server/data/findings";
import { get } from "@/server/services/understand";
import type { TestDb } from "@tests/support/db";
import { createRepoTestDb, guestA, readyDocument, SAMPLE_QUOTE } from "@tests/support/data/documents";

// get() re-verifies every quote and runs the checklist on each read. Each verifyMany call and the
// checklist block the event loop for their whole run, and the reads before them give no turn
// (in-process PGlite settles in microtasks), so without explicit yields a read is one block. A
// setImmediate ticker counts turns: two steps that see the same count ran back to back.

vi.mock("@/server/deterministic/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/deterministic/verify")>();
  return { ...actual, verifyMany: vi.fn(actual.verifyMany) };
});
vi.mock("@/server/deterministic/standard-clauses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/deterministic/standard-clauses")>();
  return { ...actual, findMissingStandardClauses: vi.fn(actual.findMissingStandardClauses) };
});

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

// A ready lease with `count` stored findings quoting SAMPLE_QUOTE.
async function analyzedDocument(count: number): Promise<string> {
  const document = await readyDocument(t, guestA);
  const analysis = (await insertAnalysisIfAbsent(t.db, guestA, { documentId: document.id, promptVersion: "test", modelUsed: "fake-model" }))!;
  const quotes = Array.from({ length: count }, () => SAMPLE_QUOTE);
  const verifications: VerifyResult[] = [];
  for (let start = 0; start < count; start += MAX_QUOTES_PER_CALL) {
    verifications.push(...verifyMany(quotes.slice(start, start + MAX_QUOTES_PER_CALL), document.canonicalText!, "text"));
  }
  await insertFindings(t.db, guestA, {
    documentId: document.id,
    analysisId: analysis.id,
    modelUsed: "fake-model",
    findings: quotes.map((quote, i) => ({ category: "obligation", quote, explanation: "x", verification: verifications[i] })),
  });
  return document.id;
}

async function turnsDuringGet(documentId: string) {
  let turns = 0;
  let ticking = true;
  const tick = () => {
    turns++;
    if (ticking) setImmediate(tick);
  };
  setImmediate(tick);
  const verifyTurns: number[] = [];
  const checklistTurns: number[] = [];
  vi.mocked(verifyMany).mockClear();
  vi.mocked(findMissingStandardClauses).mockClear();
  const actualVerify = vi.mocked(verifyMany).getMockImplementation()!;
  const actualChecklist = vi.mocked(findMissingStandardClauses).getMockImplementation()!;
  vi.mocked(verifyMany).mockImplementation((...args) => {
    verifyTurns.push(turns);
    return actualVerify(...args);
  });
  vi.mocked(findMissingStandardClauses).mockImplementation((...args) => {
    checklistTurns.push(turns);
    return actualChecklist(...args);
  });
  const startTurn = turns;
  try {
    const result = await get({ db: t.db, storage: undefined as never, llm: undefined as never, modelId: "fake-model" }, guestA, documentId);
    expect(result.analysisState).toBe("complete");
  } finally {
    ticking = false;
    vi.mocked(verifyMany).mockImplementation(actualVerify);
    vi.mocked(findMissingStandardClauses).mockImplementation(actualChecklist);
  }
  return { startTurn, verifyTurns, checklistTurns };
}

describe("get — verification and the checklist never run as one event-loop block", () => {
  it("verifyMany runs in a later turn than the reads, and the checklist in a later turn than verifyMany", async () => {
    const documentId = await analyzedDocument(3);

    const { startTurn, verifyTurns, checklistTurns } = await turnsDuringGet(documentId);

    expect(verifyTurns).toHaveLength(1);
    expect(checklistTurns).toHaveLength(1);
    expect(verifyTurns[0]).toBeGreaterThan(startTurn);
    expect(checklistTurns[0]).toBeGreaterThan(verifyTurns[0]);
  });

  it("more stored quotes than one verifyMany call takes: each chunk runs in its own turn", async () => {
    const documentId = await analyzedDocument(MAX_QUOTES_PER_CALL + 10);

    const { verifyTurns, checklistTurns } = await turnsDuringGet(documentId);

    expect(verifyTurns).toHaveLength(2);
    expect(verifyTurns[1]).toBeGreaterThan(verifyTurns[0]);
    expect(checklistTurns[0]).toBeGreaterThan(verifyTurns[1]);
  });
});
