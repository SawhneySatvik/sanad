import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres from "postgres";
import { applyMigrations, MIGRATIONS_DIR, type MigrationClient, type MigrationExecutor } from "../src/db/migrate";

// Applies the schema to the hosted Supabase database. The connection is built from separate
// host/port/user/database/password variables rather than a URL, so a password containing URL
// syntax ("@", ":", "/") needs no escaping. No variable's value is ever printed.
//
//   npm run db:migrate:remote -- --check   connect, list what would run, change nothing
//   npm run db:migrate:remote              apply, then prove anon/authenticated hold no grants

// Supabase-only files, applied after every numbered migration. The three narrow revokes go first:
// 0001's post-condition checks that no public table or function is still reachable by the Data API
// roles, which on a fresh database holds only once the objects added after 0001 was written are
// revoked too. 0003 is left out: it hands deleted files to an external function, which 0007
// replaces now that file bytes live in Postgres.
const PROD_ONLY_FILES = [
  "0004_storage_cleanup_outbox_revoke_data_api_grants.sql",
  "0005_documents_storage_ref_tombstone_guard_revoke.sql",
  "0006_storage_objects_revoke_data_api_grants.sql",
  "0001_m3_revoke_data_api_grants.sql",
  "0002_m4_ttl_and_cleanup_functions.sql",
  "0007_guest_ttl_sweep_postgres_storage.sql",
];
const PROD_ONLY_DIR = path.join(MIGRATIONS_DIR, "prod-only");

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is not set`);
  return value;
}

// The session pooler speaks IPv4 and keeps full session semantics, which DDL and DO blocks need;
// the direct host is often IPv6-only. The transaction pooler (6543) is for the app, not for this.
function connectionPrefix(): string {
  return process.env.SUPABASE_SESSION_POOLER_HOST ? "SUPABASE_SESSION_POOLER" : "SUPABASE_DIRECT_CONNECTION";
}

function wrap(sql: postgres.Sql | postgres.TransactionSql): MigrationExecutor {
  return {
    query: async <T>(text: string, params: unknown[] = []) => ({
      rows: (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[],
    }),
    // simple(): the simple-query protocol, which runs a whole multi-statement file in one call.
    exec: (text: string) => sql.unsafe(text).simple(),
  };
}

function migrationClient(sql: postgres.Sql): MigrationClient {
  return {
    ...wrap(sql),
    transaction: <T>(fn: (tx: MigrationExecutor) => Promise<T>) => sql.begin((tx) => fn(wrap(tx))) as Promise<T>,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function pendingNumbered(sql: postgres.Sql): Promise<string[]> {
  const [{ exists }] = await sql<{ exists: string | null }[]>`SELECT to_regclass('public.schema_migrations')::text AS exists`;
  const applied = exists ? new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name)) : new Set<string>();
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return files.filter((name) => !applied.has(name));
}

// Tracked separately from schema_migrations, whose runner rejects names it can't find in the
// numbered directory. Created before prod-only 0001 runs, so that file's blanket revoke covers it.
async function applyProdOnly(sql: postgres.Sql, check: boolean): Promise<string[]> {
  if (!check) {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations_prod_only (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      REVOKE ALL ON TABLE public.schema_migrations_prod_only FROM PUBLIC;
    `).simple();
  }
  const [{ exists }] = await sql<{ exists: string | null }[]>`SELECT to_regclass('public.schema_migrations_prod_only')::text AS exists`;
  const applied = new Map<string, string>(
    exists ? (await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migrations_prod_only`).map((r) => [r.name, r.checksum]) : [],
  );

  const run: string[] = [];
  for (const name of PROD_ONLY_FILES) {
    const text = await readFile(path.join(PROD_ONLY_DIR, name), "utf8");
    const checksum = sha256(text);
    const prior = applied.get(name);
    if (prior !== undefined) {
      if (prior !== checksum) throw new Error(`Applied prod-only migration ${name} was edited after it was applied`);
      continue;
    }
    run.push(name);
    if (check) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(text).simple();
      await tx.unsafe("INSERT INTO schema_migrations_prod_only (name, checksum) VALUES ($1, $2)", [name, checksum]);
    });
  }
  return run;
}

// Rule 10's denial check, against the live catalog rather than the platform default.
async function dataApiGrants(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
    SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
     ORDER BY table_name, grantee, privilege_type`;
  return rows.map((r) => `${r.grantee} ${r.privilege_type} ${r.table_name}`);
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), true);
  const check = process.argv.includes("--check");
  const prefix = connectionPrefix();
  const sql = postgres({
    host: required(`${prefix}_HOST`),
    port: Number(required(`${prefix}_PORT`)),
    database: required(`${prefix}_DATABASE`),
    username: required(`${prefix}_USER`),
    password: required("SUPABASE_DB_PASSWORD"),
    ssl: "require",
    prepare: false,
    max: 1,
    onnotice: () => {},
  });

  try {
    console.log(`db:migrate:remote: connected via ${prefix.toLowerCase().replace("supabase_", "").replaceAll("_", " ")}`);
    if (check) {
      const numbered = await pendingNumbered(sql);
      const prodOnly = await applyProdOnly(sql, true);
      console.log(`pending migrations: ${numbered.length === 0 ? "none" : numbered.join(", ")}`);
      console.log(`pending prod-only: ${prodOnly.length === 0 ? "none" : prodOnly.join(", ")}`);
      return;
    }
    const numbered = await applyMigrations(migrationClient(sql));
    console.log(`applied migrations: ${numbered.length === 0 ? "none (up to date)" : numbered.join(", ")}`);
    const prodOnly = await applyProdOnly(sql, false);
    console.log(`applied prod-only: ${prodOnly.length === 0 ? "none (up to date)" : prodOnly.join(", ")}`);

    const grants = await dataApiGrants(sql);
    if (grants.length > 0) {
      throw new Error(`Data API roles still hold table privileges:\n  ${grants.join("\n  ")}`);
    }
    console.log("denial check: anon and authenticated hold no privileges on any public table");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  // A connection error can echo its target; print only the message class and text, never the config.
  console.error(error instanceof Error ? `db:migrate:remote failed: ${error.message}` : "db:migrate:remote failed");
  process.exitCode = 1;
});
