import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  type Db,
  POSTGRES_POOL_MAX,
  PRODUCTION_DATABASE_URL_REQUIRED,
  resolveDatabaseTarget,
  UNSUPPORTED_DATABASE_URL,
} from "@/db/client";
import { documents } from "@/db/schema";
import { ConfigError } from "@/server/core/env";
import { createTestDb } from "@tests/support/db";

// createDb never connects on construction (postgres.js is lazy), so the prod branch is checked by its
// options alone — no socket is opened, no live host is contacted.

const SECRET = "hunter2-not-a-real-password";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createDb", () => {
  it("a postgres:// URL builds postgres.js with prepare: false and a small bounded pool (Supavisor rules)", async () => {
    const db = createDb("postgres://app:secret@127.0.0.1:6543/postgres");
    const client = (db as unknown as { $client: Sql }).$client;
    expect(client.options.prepare).toBe(false);
    expect(client.options.max).toBe(POSTGRES_POOL_MAX);
    expect(POSTGRES_POOL_MAX).toBeGreaterThan(1);
    expect(POSTGRES_POOL_MAX).toBeLessThanOrEqual(10);
    await client.end();
  });

  it("anything else is a PGlite dataDir (memory:// here), and queries run", async () => {
    const db = createDb("memory://");
    const [row] = await db.select({ one: sql<number>`1` }).from(sql`(SELECT 1) AS probe`);
    expect(row).toEqual({ one: 1 });
    await (db as unknown as { $client: PGlite }).$client.close();
  });

  it("a createTestDb() database is assignable to Db, so tests pass it straight into repositories", async () => {
    const t = await createTestDb();
    const db: Db = t.db;
    expect(await db.select().from(documents)).toEqual([]);
    await t.close();
  });
});

describe("createDb in production (NODE_ENV=production or VERCEL set) takes only a postgres URL", () => {
  // A path that must never be created: a PGlite fallback would make it.
  const localDir = () => path.join(tmpdir(), `lawyer-up-never-created-${SECRET}`);

  function refusal(databaseUrl: string | undefined): unknown {
    try {
      createDb(databaseUrl);
    } catch (error) {
      return error;
    }
    return null;
  }

  function expectRefused(databaseUrl: string | undefined): void {
    const error = refusal(databaseUrl);
    expect(error, String(databaseUrl)).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).variableName).toBe("DATABASE_URL");
    expect((error as Error).message).toBe(PRODUCTION_DATABASE_URL_REQUIRED);
    expect(`${(error as Error).message}\n${(error as Error).stack}`).not.toContain(SECRET);
  }

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["VERCEL=1 whatever NODE_ENV says", { NODE_ENV: "test", VERCEL: "1" }],
  ])("%s: unset, blank, memory:// and a local directory are ConfigErrors, never a PGlite", (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubEnv("DATABASE_URL", "");

    for (const value of [undefined, "   ", "memory://", localDir()]) expectRefused(value);
    expect(() => createDb()).toThrow(PRODUCTION_DATABASE_URL_REQUIRED);
    expect(existsSync(localDir())).toBe(false);
  });

  it("a postgres:// URL still builds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");

    const client = (createDb("postgresql://app:secret@127.0.0.1:6543/postgres") as unknown as { $client: Sql }).$client;

    expect(client.options.prepare).toBe(false);
    await client.end();
  });

  it("outside production (and with VERCEL blank) an unset DATABASE_URL is still the local PGlite (positive control)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");

    const db = createDb("memory://");
    const [row] = await db.select({ one: sql<number>`1` }).from(sql`(SELECT 1) AS probe`);

    expect(row).toEqual({ one: 1 });
    expect(resolveDatabaseTarget(undefined)).toEqual({ kind: "pglite", dataDir: ".pglite" });
    await (db as unknown as { $client: PGlite }).$client.close();
  });
});

describe("resolveDatabaseTarget", () => {
  it("recognises postgres URLs after trimming, whatever the scheme's case, and normalises the scheme", () => {
    expect(resolveDatabaseTarget(`  POSTGRESQL://app:${SECRET}@127.0.0.1:6543/db \n`)).toEqual({
      kind: "postgres",
      url: `postgresql://app:${SECRET}@127.0.0.1:6543/db`,
    });
    expect(resolveDatabaseTarget("Postgres://h/db")).toEqual({ kind: "postgres", url: "postgres://h/db" });
  });

  it("maps unset/blank to .pglite, memory:// to in-memory, and a plain path to a PGlite dataDir", () => {
    expect(resolveDatabaseTarget(undefined)).toEqual({ kind: "pglite", dataDir: ".pglite" });
    expect(resolveDatabaseTarget("   ")).toEqual({ kind: "pglite", dataDir: ".pglite" });
    expect(resolveDatabaseTarget(" MEMORY:// ")).toEqual({ kind: "pglite", dataDir: "memory://" });
    expect(resolveDatabaseTarget("./tmp/pglite")).toEqual({ kind: "pglite", dataDir: "./tmp/pglite" });
  });

  it("an unrecognised scheme:// is refused with a fixed message that never contains the value", () => {
    const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    for (const bad of [
      `mysql://app:${SECRET}@db.example.com/app`,
      `"postgres://app:${SECRET}@db.example.com:6543/postgres"`,
      `file:///tmp/${SECRET}`,
      `postgres//app:${SECRET}@db.example.com/postgres://`,
    ]) {
      let message = "";
      try {
        createDb(bad);
      } catch (error) {
        message = `${(error as Error).message}\n${(error as Error).stack}`;
      }
      expect(message, bad).toContain(UNSUPPORTED_DATABASE_URL);
      expect(message, bad).not.toContain(SECRET);
    }
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});

describe("scripts/db-migrate.ts never prints DATABASE_URL's password", () => {
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");

  function runMigrate(databaseUrl: string, cwd: string) {
    const result = spawnSync(process.execPath, [tsxCli, path.resolve("scripts/db-migrate.ts")], {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  it("unrecognised scheme and a mis-spaced postgres URL: non-zero exit, no password in stdout/stderr", async () => {
    // An empty cwd, so no project .env is loaded into the child.
    const cwd = await mkdtemp(path.join(tmpdir(), "lawyer-up-db-migrate-"));
    try {
      const unsupported = runMigrate(`mysql://app:${SECRET}@db.example.com/app`, cwd);
      expect(unsupported.status).toBe(1);
      expect(unsupported.output).toContain(UNSUPPORTED_DATABASE_URL);
      expect(unsupported.output).not.toContain(SECRET);

      // The original bug: a leading space made the scheme regex miss, the URL became a PGlite path,
      // and the resulting ENOENT printed it whole.
      const spaced = runMigrate(` postgres://app:${SECRET}@127.0.0.1:6543/postgres`, cwd);
      expect(spaced.status).toBe(1);
      expect(spaced.output).toContain("db:migrate only targets local PGlite");
      expect(spaced.output).not.toContain(SECRET);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
