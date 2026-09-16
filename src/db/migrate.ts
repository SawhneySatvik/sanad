import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

/** Only this directory's top level is applied; `pending/` and `prod-only/` (needs Supabase roles, pg_cron, pg_net) are never read by this runner. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Applies every not-yet-applied migration in order, each in its own transaction with its tracking
 * row. Throws if an applied file's contents changed — migrations are frozen; fixes go forward in a new file.
 */
export async function applyMigrations(client: PGlite, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sqlFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name);
  const malformed = sqlFiles.filter((name) => !MIGRATION_FILE.test(name));
  if (malformed.length > 0) {
    throw new Error(`Migration file names must match NNNN_snake_case.sql: ${malformed.join(", ")}`);
  }
  const files = sqlFiles.sort();

  const tracking = await client.query<{ exists: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS exists",
  );
  if (tracking.rows[0].exists === null) {
    await client.exec(`
      CREATE TABLE schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  const appliedRows = await client.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const applied = new Map(appliedRows.rows.map((r) => [r.name, r.checksum]));

  const missing = [...applied.keys()].filter((name) => !files.includes(name));
  if (missing.length > 0) {
    throw new Error(`Applied migrations are missing from ${dir}: ${missing.join(", ")}`);
  }

  const newlyApplied: string[] = [];
  for (const name of files) {
    const sql = await readFile(path.join(dir, name), "utf8");
    const checksum = sha256(sql);
    const priorChecksum = applied.get(name);
    if (priorChecksum !== undefined) {
      if (priorChecksum !== checksum) {
        throw new Error(`Applied migration ${name} was edited after it was applied (checksum mismatch)`);
      }
      continue;
    }
    await client.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
    });
    newlyApplied.push(name);
  }
  return newlyApplied;
}
