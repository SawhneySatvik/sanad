import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS_DIR } from "@/db/migrate";

// The runner behind db:migrate and createTestDb: ordered, tracked, idempotent, atomic per file, and
// refuses to proceed past an edited or vanished applied migration.

let dir: string;
let client: PGlite;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lawyer-up-migrate-"));
  client = new PGlite();
});
afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

async function tableNames(): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return result.rows.map((r) => r.table_name);
}

describe("applyMigrations", () => {
  it("applies files in name order, records them, and applies nothing on a re-run", async () => {
    await writeFile(path.join(dir, "0002_b.sql"), "CREATE TABLE b (a_id int REFERENCES a (id));");
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int PRIMARY KEY);");
    expect(await applyMigrations(client, dir)).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await applyMigrations(client, dir)).toEqual([]);
    const tracked = await client.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    expect(tracked.rows.map((r) => r.name)).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("a failing file leaves neither its partial schema nor a tracking row; earlier files stay applied", async () => {
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int PRIMARY KEY);");
    await writeFile(path.join(dir, "0002_broken.sql"), "CREATE TABLE half (id int); CREATE TABLE nope (id no_such_type);");
    await expect(applyMigrations(client, dir)).rejects.toThrow('type "no_such_type" does not exist');
    expect(await tableNames()).toEqual(["a", "schema_migrations"]);
    const tracked = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    expect(tracked.rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
  });

  it("refuses an applied migration whose contents changed (applied files are frozen)", async () => {
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
    await applyMigrations(client, dir);
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id bigint);");
    await expect(applyMigrations(client, dir)).rejects.toThrow("Applied migration 0001_a.sql was edited after it was applied");
  });

  it("refuses when an applied migration has disappeared from the directory", async () => {
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
    await applyMigrations(client, dir);
    await rm(path.join(dir, "0001_a.sql"));
    await expect(applyMigrations(client, dir)).rejects.toThrow("Applied migrations are missing");
  });

  it("rejects a .sql file that does not follow NNNN_snake_case.sql, and ignores subdirectories", async () => {
    await mkdir(path.join(dir, "prod-only"));
    await writeFile(path.join(dir, "prod-only", "0001_never.sql"), "CREATE TABLE never_applied (id int);");
    await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
    expect(await applyMigrations(client, dir)).toEqual(["0001_a.sql"]);
    expect(await tableNames()).toEqual(["a", "schema_migrations"]);
    await writeFile(path.join(dir, "fix.sql"), "SELECT 1;");
    await expect(applyMigrations(client, dir)).rejects.toThrow("fix.sql");
  });

  it("the real migrations directory holds exactly these files, in order, at its top level", async () => {
    const files = (await readdir(MIGRATIONS_DIR, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    expect(files.sort()).toEqual([
      "0001_core_schema.sql",
      "0002_rate_limits_and_cache.sql",
      "0003_comparisons_drafts_model_used.sql",
      "0004_drafts_jurisdiction.sql",
      "0005_titles_samples_updated_at.sql",
      "0006_storage_cleanup_outbox.sql",
      "0007_storage_cleanup_retry_and_thread_index.sql",
      "0008_storage_objects.sql",
    ]);
  });
});
