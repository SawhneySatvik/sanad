import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS_DIR } from "@/db/migrate";
import { createTestDb, type TestDb } from "@tests/support/db";

// 0005: title (documents/comparisons/drafts), sample_id (documents), user_instructions (drafts), and
// updated_at (documents/comparisons/drafts). Raw SQL throughout: the typed builder would stamp
// updated_at/created_at/uploaded_at with defaultNow() itself, hiding exactly the backfill this file
// needs to prove.

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("0005: new column shape", () => {
  it("title/sample_id/user_instructions are nullable text with no default", async () => {
    const result = await t.client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; has_default: boolean }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default IS NOT NULL AS has_default
         FROM information_schema.columns
        WHERE table_name IN ('documents', 'comparisons', 'drafts')
          AND column_name IN ('title', 'sample_id', 'user_instructions')
        ORDER BY table_name, column_name`,
    );
    expect(result.rows).toEqual([
      { table_name: "comparisons", column_name: "title", data_type: "text", is_nullable: "YES", has_default: false },
      { table_name: "documents", column_name: "sample_id", data_type: "text", is_nullable: "YES", has_default: false },
      { table_name: "documents", column_name: "title", data_type: "text", is_nullable: "YES", has_default: false },
      { table_name: "drafts", column_name: "title", data_type: "text", is_nullable: "YES", has_default: false },
      { table_name: "drafts", column_name: "user_instructions", data_type: "text", is_nullable: "YES", has_default: false },
    ]);
  });

  it("updated_at is timestamptz NOT NULL DEFAULT now() on all three tables", async () => {
    const result = await t.client.query<{ table: string; type: string; not_null: boolean; default_expr: string }>(
      `SELECT c.relname AS table, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attname = 'updated_at' AND c.relname IN ('documents', 'comparisons', 'drafts')
        ORDER BY c.relname`,
    );
    expect(result.rows).toEqual([
      { table: "comparisons", type: "timestamp with time zone", not_null: true, default_expr: "now()" },
      { table: "documents", type: "timestamp with time zone", not_null: true, default_expr: "now()" },
      { table: "drafts", type: "timestamp with time zone", not_null: true, default_expr: "now()" },
    ]);
  });

  it("a fresh insert with no updated_at gets now(), and no new columns block the row", async () => {
    const doc = await t.client.query<{ title: string | null; sample_id: string | null; updated_at: string }>(
      `INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, expires_at)
       VALUES ('guest-a', 'guest-a/x/a.pdf', 'a.pdf', 'application/pdf', now() + interval '2 hours')
       RETURNING title, sample_id, updated_at`,
    );
    expect(doc.rows[0].title).toBeNull();
    expect(doc.rows[0].sample_id).toBeNull();
  });
});

describe("0005: backfill on a database that already holds rows", () => {
  it("updated_at is backfilled from uploaded_at/created_at — never tied to the migration's own now()", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lawyer-up-0005-"));
    const client = new PGlite();
    try {
      const before = [
        "0001_core_schema.sql",
        "0002_rate_limits_and_cache.sql",
        "0003_comparisons_drafts_model_used.sql",
        "0004_drafts_jurisdiction.sql",
      ];
      for (const name of before) await copyFile(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
      await applyMigrations(client, dir);

      const docA = await client.query<{ id: string }>(
        `INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, uploaded_at, expires_at)
         VALUES ('guest-a', 'guest-a/1/a.pdf', 'a.pdf', 'application/pdf', '2020-01-01T00:00:00Z', now() + interval '2 hours')
         RETURNING id`,
      );
      const docB = await client.query<{ id: string }>(
        `INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, uploaded_at, expires_at)
         VALUES ('guest-a', 'guest-a/2/b.pdf', 'b.pdf', 'application/pdf', '2021-06-15T12:00:00Z', now() + interval '2 hours')
         RETURNING id`,
      );
      await client.query(
        `INSERT INTO comparisons (owner_guest_session_id, document_a_id, document_b_id, expires_at, model_used, created_at)
         VALUES ('guest-a', $1, $2, now() + interval '2 hours', 'gemini-test', '2019-03-01T00:00:00Z')`,
        [docA.rows[0].id, docB.rows[0].id],
      );
      await client.exec(
        `INSERT INTO drafts (owner_guest_session_id, document_type, mode, content, revision_number, expires_at, model_used, created_at)
         VALUES ('guest-a', 'nda', 'from_scratch', 'c', 1, now() + interval '2 hours', 'gemini-test', '2022-11-20T09:30:00Z')`,
      );

      // Pointed at the real directory, not the temp copies: it applies the remaining common
      // migrations on top of the rows seeded under 0001-0004, and ignores pending/.
      expect(await applyMigrations(client, MIGRATIONS_DIR)).toEqual([
        "0005_titles_samples_updated_at.sql",
        "0006_storage_cleanup_outbox.sql",
        "0007_storage_cleanup_retry_and_thread_index.sql",
        "0008_storage_objects.sql",
      ]);

      const docs = await client.query<{ matches: boolean; year: number; title: string | null; sample_id: string | null }>(
        `SELECT (updated_at = uploaded_at) AS matches, extract(year FROM updated_at)::int AS year, title, sample_id
           FROM documents ORDER BY uploaded_at`,
      );
      expect(docs.rows).toEqual([
        { matches: true, year: 2020, title: null, sample_id: null },
        { matches: true, year: 2021, title: null, sample_id: null },
      ]);

      const comparisons = await client.query<{ matches: boolean; year: number; title: string | null }>(
        `SELECT (updated_at = created_at) AS matches, extract(year FROM updated_at)::int AS year, title FROM comparisons`,
      );
      expect(comparisons.rows).toEqual([{ matches: true, year: 2019, title: null }]);

      const drafts = await client.query<{ matches: boolean; year: number; title: string | null; user_instructions: string | null }>(
        `SELECT (updated_at = created_at) AS matches, extract(year FROM updated_at)::int AS year, title, user_instructions FROM drafts`,
      );
      expect(drafts.rows).toEqual([{ matches: true, year: 2022, title: null, user_instructions: null }]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
