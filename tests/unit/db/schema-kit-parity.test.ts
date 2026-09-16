import { PGlite } from "@electric-sql/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";

// Definition-level parity between schema.ts and the hand-written SQL. drizzle-kit is used here as a
// CHECK only: it renders schema.ts to DDL in memory, that DDL is applied to a second in-memory PGlite,
// and Postgres itself normalises both sides (pg_get_expr, pg_get_constraintdef, indexdef) before they
// are compared. Nothing drizzle-kit produces is ever written to disk or applied as a migration.
// Triggers and trigger functions exist only in the SQL (Drizzle cannot express them) and are covered
// by migrations.test.ts.

async function catalog(client: PGlite): Promise<string[]> {
  const columns = await client.query<{ entry: string }>(
    `SELECT format('column %s.%s %s %s default=%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                   CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE 'NULL' END,
                   coalesce(pg_get_expr(d.adbin, d.adrelid), '-')) AS entry
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relname <> 'schema_migrations'`,
  );
  const constraints = await client.query<{ entry: string }>(
    `SELECT format('constraint %s.%s %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) AS entry
       FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype IN ('p', 'u', 'f', 'c')
        AND conrelid::regclass::text <> 'schema_migrations'`,
  );
  const indexes = await client.query<{ entry: string }>(
    `SELECT 'index ' || indexdef AS entry FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  const enums = await client.query<{ entry: string }>(
    `SELECT format('enum %s %s', t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)) AS entry
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`,
  );
  return [...columns.rows, ...constraints.rows, ...indexes.rows, ...enums.rows].map((r) => r.entry).sort();
}

function diff(handWritten: string[], fromSchemaTs: string[]): string[] {
  const kit = new Set(fromSchemaTs);
  const sql = new Set(handWritten);
  return [
    ...handWritten.filter((e) => !kit.has(e)).map((e) => `only in migrations SQL: ${e}`),
    ...fromSchemaTs.filter((e) => !sql.has(e)).map((e) => `only in schema.ts: ${e}`),
  ];
}

// Both catalogs are built ONCE per file. The mutation test below alters that same clone, safe
// because handWritten was snapshotted first. The generous timeouts avoid a gate that only fails
// under parallel load — that would be a flaky gate, not a signal.
const SETUP_TIMEOUT_MS = 120_000;

let t: TestDb;
let handWritten: string[];
let kitCatalog: string[];
beforeAll(async () => {
  t = await createTestDb();
  handWritten = await catalog(t.client);
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema as Record<string, unknown>));
  const kitDb = new PGlite();
  try {
    await kitDb.exec(statements.join(";\n"));
    kitCatalog = await catalog(kitDb);
  } finally {
    await kitDb.close();
  }
}, SETUP_TIMEOUT_MS);
afterAll(async () => {
  await t.close();
}, SETUP_TIMEOUT_MS);

describe("(e) schema.ts ⇄ migrations SQL, definition by definition", () => {
  it("columns (type, nullability, default EXPRESSION), constraints (full definition), indexes and enums are identical", () => {
    expect(handWritten.length).toBeGreaterThan(250); // guards against comparing two empty catalogs
    expect(diff(handWritten, kitCatalog)).toEqual([]);
  });

  it("a changed default expression, CHECK body, FK action or index shape under the same name is reported", async () => {
    await t.client.exec(`
      ALTER TABLE documents ALTER COLUMN jurisdiction SET DEFAULT 'US';
      ALTER TABLE findings DROP CONSTRAINT findings_span_check;
      ALTER TABLE findings ADD CONSTRAINT findings_span_check CHECK (quote_span_start >= 0);
      ALTER TABLE thread_documents DROP CONSTRAINT thread_documents_document_id_fkey;
      ALTER TABLE thread_documents ADD CONSTRAINT thread_documents_document_id_fkey
        FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE RESTRICT;
      DROP INDEX messages_thread_id_created_at_id_idx;
      CREATE INDEX messages_thread_id_created_at_id_idx ON messages (thread_id, created_at, id);
    `);
    const reported = diff(await catalog(t.client), kitCatalog);
    expect(reported).toHaveLength(8);
    for (const needle of [
      "column documents.jurisdiction text NOT NULL default='US'::text",
      "constraint findings.findings_span_check CHECK ((quote_span_start >= 0))",
      "constraint thread_documents.thread_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE RESTRICT",
      "index CREATE INDEX messages_thread_id_created_at_id_idx ON public.messages USING btree (thread_id, created_at, id)",
    ]) {
      expect(reported).toContain(`only in migrations SQL: ${needle}`);
    }
  }, SETUP_TIMEOUT_MS);
});
