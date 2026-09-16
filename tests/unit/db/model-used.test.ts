import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS_DIR } from "@/db/migrate";
import { createTestDb, type TestDb } from "@tests/support/db";

// M5 (0003): comparisons.model_used and drafts.model_used are required and non-blank, so a
// fallback-model result stays distinguishable after a reload. Raw SQL on purpose: the typed builder
// would not even let a test omit model_used.

let t: TestDb;
let documentId: string;
beforeEach(async () => {
  t = await createTestDb();
  const doc = await t.client.query<{ id: string }>(
    `INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, expires_at)
     VALUES ('guest-a', 'guest-a/1/a.pdf', 'a.pdf', 'application/pdf', now() + interval '2 hours') RETURNING id`,
  );
  documentId = doc.rows[0].id;
});
afterEach(async () => {
  await t.close();
});

type PgError = { code?: string; constraint?: string; column?: string };

async function rejection(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (error) {
    return error as PgError;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

const tables = {
  comparisons: {
    withoutModel: () =>
      t.client.query(
        `INSERT INTO comparisons (owner_guest_session_id, document_a_id, document_b_id, expires_at)
         VALUES ('guest-a', $1, $1, now() + interval '2 hours')`,
        [documentId],
      ),
    withModel: (modelUsed: string) =>
      t.client.query(
        `INSERT INTO comparisons (owner_guest_session_id, document_a_id, document_b_id, expires_at, model_used)
         VALUES ('guest-a', $1, $1, now() + interval '2 hours', $2) RETURNING model_used`,
        [documentId, modelUsed],
      ),
  },
  drafts: {
    withoutModel: () =>
      t.client.query(
        `INSERT INTO drafts (owner_guest_session_id, document_type, mode, content, revision_number, expires_at)
         VALUES ('guest-a', 'nda', 'from_scratch', 'c', 1, now() + interval '2 hours')`,
      ),
    withModel: (modelUsed: string) =>
      t.client.query(
        `INSERT INTO drafts (owner_guest_session_id, document_type, mode, content, revision_number, expires_at, model_used)
         VALUES ('guest-a', 'nda', 'from_scratch', 'c', 1, now() + interval '2 hours', $1) RETURNING model_used`,
        [modelUsed],
      ),
  },
} as const;

describe("M5: model_used is required and non-blank on comparisons and drafts", () => {
  for (const [table, insert] of Object.entries(tables)) {
    it(`${table}: an insert without model_used is rejected (NOT NULL); drop NOT NULL and it is accepted`, async () => {
      const error = await rejection(insert.withoutModel);
      expect(error.code).toBe("23502");
      expect(error.column).toBe("model_used");
      await t.client.exec(`ALTER TABLE ${table} ALTER COLUMN model_used DROP NOT NULL`);
      await expect(insert.withoutModel()).resolves.toBeDefined();
    });

    it(`${table}: a blank or whitespace-only model_used is rejected by ${table}_model_used_not_blank_check; drop it and it is accepted`, async () => {
      for (const blank of ["", "   ", "\t\n"]) {
        expect((await rejection(() => insert.withModel(blank))).constraint, JSON.stringify(blank)).toBe(
          `${table}_model_used_not_blank_check`,
        );
      }
      await t.client.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_model_used_not_blank_check`);
      await expect(insert.withModel("")).resolves.toBeDefined();
    });

    it(`${table}: a real model id is stored and read back`, async () => {
      const result = await insert.withModel("gemma-3-27b-it");
      expect(result.rows).toEqual([{ model_used: "gemma-3-27b-it" }]);
    });
  }

  it("on a database that already holds rows, 0003 fails and rolls back whole — no invented model_used", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lawyer-up-m5-"));
    const client = new PGlite();
    try {
      for (const name of ["0001_core_schema.sql", "0002_rate_limits_and_cache.sql"]) {
        await copyFile(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
      }
      await applyMigrations(client, dir);
      await client.exec(`
        INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, expires_at)
        VALUES ('g', 'g/1/a.pdf', 'a.pdf', 'application/pdf', now() + interval '2 hours');
        INSERT INTO comparisons (owner_guest_session_id, document_a_id, document_b_id, expires_at)
        SELECT 'g', id, id, now() + interval '2 hours' FROM documents;
      `);
      await copyFile(path.join(MIGRATIONS_DIR, "0003_comparisons_drafts_model_used.sql"), path.join(dir, "0003_comparisons_drafts_model_used.sql"));
      await expect(applyMigrations(client, dir)).rejects.toThrow('column "model_used" of relation "comparisons" contains null values');
      const state = await client.query<{ columns: number; tracked: number }>(
        `SELECT (SELECT count(*)::int FROM information_schema.columns
                  WHERE column_name = 'model_used' AND table_name IN ('comparisons', 'drafts')) AS columns,
                (SELECT count(*)::int FROM schema_migrations WHERE name LIKE '0003%') AS tracked`,
      );
      expect(state.rows[0]).toEqual({ columns: 0, tracked: 0 });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
