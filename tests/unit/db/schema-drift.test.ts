import type { PGlite } from "@electric-sql/pglite";
import { is } from "drizzle-orm";
import { getTableConfig, isPgEnum, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENT_CATEGORIES, INPUT_MODES, VERIFICATION_STATUSES } from "@/server/core/types";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";

// (e) schema.ts and the hand-written SQL can't silently diverge: every table, column (nullability,
// type, default presence, primary key), enum (labels, in order), FK (name, ON DELETE rule, target),
// CHECK name and index name is compared in BOTH directions against the migrated catalog.

const exported: unknown[] = Object.values(schema);
const tables = exported.filter((v): v is PgTable => is(v, PgTable));
const enums = exported.filter(isPgEnum);

const DELETE_RULES: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };

async function rows<T>(client: PGlite, query: string): Promise<T[]> {
  return (await client.query<T>(query)).rows;
}

function compareSets(label: (item: string) => string, inSchema: Iterable<string>, inDb: Iterable<string>): string[] {
  const a = new Set(inSchema);
  const b = new Set(inDb);
  return [
    ...[...a].filter((x) => !b.has(x)).map((x) => `${label(x)}: in schema.ts, missing from DB`),
    ...[...b].filter((x) => !a.has(x)).map((x) => `${label(x)}: in DB, missing from schema.ts`),
  ];
}

async function diffSchemaAgainstDb(client: PGlite): Promise<string[]> {
  const diffs: string[] = [];

  const dbTables = await rows<{ table_name: string }>(
    client,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
  );
  diffs.push(...compareSets((x) => `table ${x}`, tables.map((tbl) => getTableConfig(tbl).name), dbTables.map((r) => r.table_name)));

  const dbColumns = await rows<{ table_name: string; column_name: string; not_null: boolean; has_default: boolean; sql_type: string }>(
    client,
    `SELECT table_name, column_name, is_nullable = 'NO' AS not_null, column_default IS NOT NULL AS has_default,
            CASE WHEN data_type = 'USER-DEFINED' THEN udt_name
                 WHEN data_type = 'ARRAY' THEN substr(udt_name, 2) || '[]'
                 ELSE data_type END AS sql_type
       FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const dbPrimaryKeys = await rows<{ table_name: string; column_name: string }>(
    client,
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
      WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace`,
  );
  const dbForeignKeys = await rows<{ table_name: string; conname: string; rule: string; target: string }>(
    client,
    `SELECT conrelid::regclass::text AS table_name, conname, confdeltype AS rule, confrelid::regclass::text AS target
       FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
  );
  const dbChecks = await rows<{ table_name: string; conname: string }>(
    client,
    `SELECT conrelid::regclass::text AS table_name, conname
       FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`,
  );
  const dbIndexes = await rows<{ table_name: string; indexname: string }>(
    client,
    `SELECT c.relname AS table_name, ic.relname AS indexname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE NOT i.indisprimary AND c.relnamespace = 'public'::regnamespace`,
  );

  for (const table of tables) {
    const config = getTableConfig(table);
    const name = config.name;
    const inDb = new Map(dbColumns.filter((c) => c.table_name === name).map((c) => [c.column_name, c]));
    diffs.push(...compareSets((x) => `column ${name}.${x}`, config.columns.map((c) => c.name), inDb.keys()));

    const schemaPk = new Set([
      ...config.columns.filter((c) => c.primary).map((c) => c.name),
      ...config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
    ]);
    const dbPk = new Set(dbPrimaryKeys.filter((r) => r.table_name === name).map((r) => r.column_name));

    for (const column of config.columns) {
      const db = inDb.get(column.name);
      if (!db) continue;
      const where = `column ${name}.${column.name}`;
      if (column.notNull !== db.not_null) {
        diffs.push(`${where}: schema.ts ${column.notNull ? "NOT NULL" : "nullable"}, DB ${db.not_null ? "NOT NULL" : "nullable"}`);
      }
      if (column.getSQLType() !== db.sql_type) {
        diffs.push(`${where}: schema.ts type ${column.getSQLType()}, DB type ${db.sql_type}`);
      }
      if (column.hasDefault !== db.has_default) {
        diffs.push(`${where}: schema.ts ${column.hasDefault ? "has a default" : "no default"}, DB ${db.has_default ? "has a default" : "no default"}`);
      }
      if (schemaPk.has(column.name) !== dbPk.has(column.name)) {
        diffs.push(`${where}: primary-key membership differs`);
      }
    }

    const dbFks = new Map(dbForeignKeys.filter((f) => f.table_name === name).map((f) => [f.conname, f]));
    diffs.push(...compareSets((x) => `fk ${name}: ${x}`, config.foreignKeys.map((fk) => fk.getName()), dbFks.keys()));
    for (const fk of config.foreignKeys) {
      const db = dbFks.get(fk.getName());
      if (!db) continue;
      const schemaRule = fk.onDelete ?? "no action";
      if (schemaRule !== DELETE_RULES[db.rule]) {
        diffs.push(`fk ${name}: ${fk.getName()} ON DELETE schema.ts ${schemaRule}, DB ${DELETE_RULES[db.rule]}`);
      }
      const target = getTableConfig(fk.reference().foreignTable).name;
      if (target !== db.target) diffs.push(`fk ${name}: ${fk.getName()} targets schema.ts ${target}, DB ${db.target}`);
    }

    diffs.push(
      ...compareSets(
        (x) => `check ${name}: ${x}`,
        config.checks.map((c) => c.name),
        dbChecks.filter((c) => c.table_name === name).map((c) => c.conname),
      ),
    );

    diffs.push(
      ...compareSets(
        (x) => `index ${name}: ${x}`,
        [...config.indexes.map((i) => i.config.name ?? "<unnamed>"), ...config.uniqueConstraints.map((u) => u.getName() ?? "<unnamed>")],
        dbIndexes.filter((i) => i.table_name === name).map((i) => i.indexname),
      ),
    );
  }

  const dbEnums = await rows<{ name: string; labels: string[] }>(
    client,
    `SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typnamespace = 'public'::regnamespace
      GROUP BY t.typname`,
  );
  const dbEnumMap = new Map(dbEnums.map((e) => [e.name, e.labels]));
  diffs.push(...compareSets((x) => `enum ${x}`, enums.map((e) => e.enumName), dbEnumMap.keys()));
  for (const e of enums) {
    const labels = dbEnumMap.get(e.enumName);
    if (labels && labels.join(",") !== e.enumValues.join(",")) {
      diffs.push(`enum ${e.enumName}: schema.ts [${e.enumValues.join(", ")}], DB [${labels.join(", ")}]`);
    }
  }

  return diffs.sort();
}

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("(e) schema drift: schema.ts vs the migrated database", () => {
  it("covers every table and enum schema.ts exports (guards against an empty comparison)", () => {
    expect(tables).toHaveLength(18);
    expect(enums).toHaveLength(8);
  });

  it("finds no difference in either direction", async () => {
    expect(await diffSchemaAgainstDb(t.client)).toEqual([]);
  });

  it("shared vocabulary: the DB enums carry exactly src/server/core/types.ts's values, in order", async () => {
    const labels = async (name: string) =>
      (
        await t.client.query<{ label: string }>(
          `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY e.enumsortorder`,
          [name],
        )
      ).rows.map((r) => r.label);
    expect(await labels("input_mode")).toEqual([...INPUT_MODES]);
    expect(await labels("verification_status")).toEqual([...VERIFICATION_STATUSES]);
    expect(await labels("finding_category")).toEqual([...DOCUMENT_CATEGORIES]);
  });

  it("each kind of divergence introduced into the DB is reported", async () => {
    await t.client.exec(`
      ALTER TABLE messages ALTER COLUMN id SET DEFAULT gen_random_uuid();
      ALTER TABLE threads ALTER COLUMN title SET NOT NULL;
      ALTER TABLE drafts ADD COLUMN stray text;
      ALTER TABLE users DROP COLUMN avatar_url;
      ALTER TABLE projects ALTER COLUMN color TYPE varchar(20);
      ALTER TYPE message_mode ADD VALUE 'hybrid';
      DROP INDEX documents_expires_at_idx;
      ALTER TABLE findings DROP CONSTRAINT findings_document_id_fkey;
      ALTER TABLE findings ADD CONSTRAINT findings_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE RESTRICT;
      ALTER TABLE drafts DROP CONSTRAINT drafts_grounding_only_when_grounded_check;
    `);
    expect(await diffSchemaAgainstDb(t.client)).toEqual(
      [
        "check drafts: drafts_grounding_only_when_grounded_check: in schema.ts, missing from DB",
        "column drafts.stray: in DB, missing from schema.ts",
        "column messages.id: schema.ts no default, DB has a default",
        "column projects.color: schema.ts type text, DB type character varying",
        "column threads.title: schema.ts nullable, DB NOT NULL",
        "column users.avatar_url: in schema.ts, missing from DB",
        "enum message_mode: schema.ts [grounded, general], DB [grounded, general, hybrid]",
        "fk findings: findings_document_id_fkey ON DELETE schema.ts cascade, DB restrict",
        "index documents: documents_expires_at_idx: in schema.ts, missing from DB",
      ].sort(),
    );
  });
});
