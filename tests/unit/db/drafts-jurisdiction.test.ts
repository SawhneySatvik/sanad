import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS_DIR } from "@/db/migrate";
import { createTestDb, type TestDb } from "@tests/support/db";

// M6 (0004): drafts.jurisdiction — ISO country code, default 'IN', mirroring documents.jurisdiction.
// Raw SQL so the test controls exactly which columns an INSERT names.

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

function insertDraft(jurisdiction?: string) {
  return jurisdiction === undefined
    ? t.client.query<{ jurisdiction: string }>(
        `INSERT INTO drafts (owner_guest_session_id, document_type, mode, content, revision_number, expires_at, model_used)
         VALUES ('guest-a', 'nda', 'from_scratch', 'c', 1, now() + interval '2 hours', 'gemini-test') RETURNING jurisdiction`,
      )
    : t.client.query<{ jurisdiction: string }>(
        `INSERT INTO drafts (owner_guest_session_id, document_type, mode, content, revision_number, expires_at, model_used, jurisdiction)
         VALUES ('guest-a', 'nda', 'from_scratch', 'c', 1, now() + interval '2 hours', 'gemini-test', $1) RETURNING jurisdiction`,
        [jurisdiction],
      );
}

async function rejectionConstraint(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { constraint?: string }).constraint;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

describe("M6: drafts.jurisdiction", () => {
  it("a draft inserted without jurisdiction gets 'IN'", async () => {
    expect((await insertDraft()).rows).toEqual([{ jurisdiction: "IN" }]);
  });

  it("an invalid code is rejected by drafts_jurisdiction_iso_check; drop it and the same insert is accepted", async () => {
    for (const bad of ["india", "in", "IND", "I", "", "In"]) {
      expect(await rejectionConstraint(() => insertDraft(bad)), JSON.stringify(bad)).toBe("drafts_jurisdiction_iso_check");
    }
    await t.client.exec("ALTER TABLE drafts DROP CONSTRAINT drafts_jurisdiction_iso_check");
    expect((await insertDraft("india")).rows).toEqual([{ jurisdiction: "india" }]);
  });

  it("a valid ISO code other than the default is stored as given", async () => {
    expect((await insertDraft("US")).rows).toEqual([{ jurisdiction: "US" }]);
  });

  it("mirrors documents.jurisdiction exactly: type, NOT NULL, default expression and CHECK body", async () => {
    const result = await t.client.query<{ table: string; type: string; not_null: boolean; default_expr: string; check_def: string }>(
      `SELECT c.relname AS table, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr,
              (SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k
                WHERE k.conrelid = c.oid AND k.conname = c.relname || '_jurisdiction_iso_check') AS check_def
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attname = 'jurisdiction' AND c.relname IN ('documents', 'drafts')
        ORDER BY c.relname`,
    );
    const [documents, drafts] = result.rows;
    expect(documents.table).toBe("documents");
    expect(drafts.table).toBe("drafts");
    expect({ ...drafts, table: "documents" }).toEqual(documents);
    expect(drafts).toMatchObject({ type: "text", not_null: true, default_expr: "'IN'::text" });
    expect(drafts.check_def).toContain("^[A-Z]{2}$");
  });

  it("on a database that already holds drafts, 0004 backfills them with 'IN' (the spec default, not an invented value)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lawyer-up-m6-"));
    const client = new PGlite();
    try {
      const before = ["0001_core_schema.sql", "0002_rate_limits_and_cache.sql", "0003_comparisons_drafts_model_used.sql"];
      for (const name of before) await copyFile(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
      await applyMigrations(client, dir);
      await client.exec(`
        INSERT INTO drafts (owner_guest_session_id, document_type, mode, content, revision_number, expires_at, model_used)
        VALUES ('g', 'nda', 'from_scratch', 'c', 1, now() + interval '2 hours', 'gemini-test');
      `);
      await copyFile(path.join(MIGRATIONS_DIR, "0004_drafts_jurisdiction.sql"), path.join(dir, "0004_drafts_jurisdiction.sql"));
      expect(await applyMigrations(client, dir)).toEqual(["0004_drafts_jurisdiction.sql"]);
      const rows = await client.query<{ jurisdiction: string }>("SELECT jurisdiction FROM drafts");
      expect(rows.rows).toEqual([{ jurisdiction: "IN" }]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
