// Shared harness for the Draft service tests: real PGlite (via tests/support/data/documents.ts's
// createRepoTestDb), FakeLlmClient at the provider boundary — nothing else is faked. That module is
// imported read-only, to create ready grounding documents.

import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { aiSectionKeys, requiredSectionKeys, type DraftableDocumentTypeId } from "@/server/deterministic/draft-templates";
import { caught, createRepoTestDb, guestA, guestB, readyDocument, userA, userB, USER_A_ID, USER_B_ID } from "@tests/support/data/documents";
import type { LlmClient } from "@/server/llm/types";
import type { DraftDeps } from "@/server/services/draft";

export { caught, guestA, guestB, readyDocument, userA, userB, USER_A_ID, USER_B_ID };

// A valid, scripted model response for a documentType's ai_generated sections — every key present,
// non-blank text, so schema.safeParse succeeds on the first attempt (no repair retry consumed).
export function draftModelOutput(documentType: DraftableDocumentTypeId, overrides: Record<string, string> = {}): { sections: Record<string, string> } {
  return {
    sections: Object.fromEntries(aiSectionKeys(documentType).map((key) => [key, overrides[key] ?? `Generated body for ${key}.`])),
  };
}

/** The required section keys a documentType's template fills itself — never sent to the model. */
export function templatedKeysFor(documentType: DraftableDocumentTypeId): string[] {
  const aiKeys = new Set(aiSectionKeys(documentType));
  return requiredSectionKeys(documentType).filter((key) => !aiKeys.has(key));
}

/** The Draft service test harness: a real DB, row counters, and a `deps()` builder for a given LlmClient. */
export interface Harness {
  t: TestDb;
  deps(llm: LlmClient): DraftDeps;
  counts(): Promise<{ drafts: number; sections: number }>;
  close(): Promise<void>;
}

/** Builds a fresh Draft service `Harness` over its own isolated database. */
export async function createHarness(): Promise<Harness> {
  const t = await createRepoTestDb();

  async function count(table: string): Promise<number> {
    const result = await t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0].n;
  }

  return {
    t,
    deps: (llm) => ({ db: t.db, llm }),
    counts: async () => ({ drafts: await count("drafts"), sections: await count("draft_sections") }),
    close: async () => {
      await t.close();
    },
  };
}

export type { Principal };
export { schema };
