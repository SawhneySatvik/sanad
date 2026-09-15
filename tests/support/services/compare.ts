// Shared harness for the Compare service tests: real PGlite (createRepoTestDb), real documents made
// through data/documents.ts, FakeLlmClient at the provider boundary — nothing else is faked
// (CLAUDE.md mocking policy).

import { readFileSync } from "node:fs";
import path from "node:path";
import type { TestDb } from "@tests/support/db";
import type { InputMode, Principal } from "@/server/core/types";
import type { Document } from "@/server/data/documents";
import { createRepoTestDb, readyDocument } from "@tests/support/data/documents";
import type { FakeLlmScript } from "@tests/support/fakes/llm-client";
import type { LlmClient } from "@/server/llm/types";
import type { CompareDeps } from "@/server/services/compare";

export { guestA, guestB, userA, userB, USER_A_ID, USER_B_ID } from "@tests/support/data/documents";

/** The "before" side of the Compare fixture pair; `LEASE_B` is its edited "after" side. */
export const LEASE_A = readFileSync(path.join(process.cwd(), "tests", "fixtures", "documents", "leave_and_license.txt"), "utf8");

// Four injected changes: clause 2.1's fee and 2.2's refund period edited, 3.2 removed, 4.3 added.
export const LEASE_B = LEASE_A.replace("Rs. 32,000/-", "Rs. 35,000/-")
  .replace("within 15 days of vacating", "within 45 days of vacating")
  .replace("3.2 The Licensor shall be responsible for structural repairs to the Licensed Premises.\n\n", "")
  .replace(
    "normal wear and tear excepted.\n",
    "normal wear and tear excepted.\n\n4.3 The Licensee shall pay a late fee of Rs. 500 per day for any delay in payment of the license fee.\n",
  );

// The changes findCandidateChanges reports for LEASE_A → LEASE_B, in order.
export const LEASE_CHANGES = [
  { id: "c1", changeType: "changed", clause: "2.1" },
  { id: "c2", changeType: "changed", clause: "2.2" },
  { id: "c3", changeType: "removed", clause: "3.2" },
  { id: "c4", changeType: "added", clause: "4.3" },
] as const;

// Words the model might quote: each exists only inside its own clause, on its own side.
export const QUOTES = {
  feeA: "Rs. 32,000/-",
  feeB: "Rs. 35,000/-",
  refundA: "within 15 days of vacating the premises",
  refundB: "within 45 days of vacating the premises",
  lateFeeB: "a late fee of Rs. 500 per day",
  // In clause 2.2 too, but its first occurrence is the WHEREAS recital — outside the clause.
  elsewhere: "the Licensed Premises",
  fabricated: "The Licensee may sublet the premises without consent",
} as const;

const CANDIDATE_HEADER = /<<<CHANGES-[0-9a-f]{16} (c\d+) (?:added|removed|changed)>>>/g;

/** The candidate change ids a Compare synthesis prompt named, in the order they appear. */
export function candidateIds(userPrompt: string): string[] {
  return [...userPrompt.matchAll(CANDIDATE_HEADER)].map((match) => match[1]);
}

/** Per-candidate-id quote overrides for `explainAll`'s scripted model response. */
export type ModelQuotes = Record<string, { quoteA?: string | null; quoteB?: string | null }>;

type FakeLlmFunction = Extract<FakeLlmScript, (...args: never) => unknown>;

// A model that explains every candidate it is sent, quoting only what `quotes` gives it.
export function explainAll(quotes: ModelQuotes = {}): FakeLlmFunction {
  return ({ input }) => ({
    data: {
      changes: candidateIds(input.userPrompt).map((id) => ({
        id,
        explanation: `Model explanation of ${id}.`,
        quoteA: quotes[id]?.quoteA ?? null,
        quoteB: quotes[id]?.quoteB ?? null,
      })),
    },
  });
}

/** The Compare service test harness: a real DB, a document builder, row counters, and a `deps()` builder for a given LlmClient. */
export interface CompareHarness {
  t: TestDb;
  deps(llm: LlmClient): CompareDeps;
  document(principal: Principal, text: string, inputMode?: InputMode): Promise<Document>;
  counts(): Promise<{ comparisons: number; changes: number }>;
  close(): Promise<void>;
}

/** Builds a fresh Compare service `CompareHarness` over its own isolated database. */
export async function createCompareHarness(): Promise<CompareHarness> {
  const t = await createRepoTestDb();
  async function count(table: string): Promise<number> {
    const result = await t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0].n;
  }
  return {
    t,
    deps: (llm) => ({ db: t.db, llm }),
    document: (principal, text, inputMode = "text") => readyDocument(t, principal, text, inputMode),
    counts: async () => ({ comparisons: await count("comparisons"), changes: await count("comparison_changes") }),
    close: () => t.close(),
  };
}
