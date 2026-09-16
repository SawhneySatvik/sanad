import { PGlite } from "@electric-sql/pglite";
import { loadEnvConfig } from "@next/env";
import { resolveDatabaseTarget } from "../src/db/client";
import { applyMigrations, MIGRATIONS_DIR } from "../src/db/migrate";
import { optionalEnv } from "../src/server/core/env";

// Local PGlite only. Production schema changes go through the Supabase CLI over the direct
// connection at deploy time, never through this script.
async function main(): Promise<void> {
  // tsx does not read .env but `next dev` does; load the same files the same way so this migrates the
  // database the app will actually open. A variable already set in the shell still wins.
  loadEnvConfig(process.cwd(), true);
  // Throws a fixed message (never the value) for an unrecognised scheme://.
  const target = resolveDatabaseTarget(optionalEnv("DATABASE_URL"));
  if (target.kind === "postgres") {
    throw new Error("db:migrate only targets local PGlite; DATABASE_URL is a postgres:// URL");
  }
  const client = new PGlite(target.dataDir);
  try {
    const applied = await applyMigrations(client);
    console.log(
      applied.length === 0
        ? `db:migrate: ${target.dataDir} is up to date (${MIGRATIONS_DIR})`
        : `db:migrate: applied ${applied.length} migration(s) to ${target.dataDir}: ${applied.join(", ")}`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
