import { getDb, resolveDatabaseTarget } from "../src/db/client";
import { optionalEnv } from "../src/server/core/env";
import { runStorageCleanupBatch } from "../src/server/storage/cleanup-worker";
import { LocalFsStoragePurger } from "../src/server/storage/purger";

async function main() {
  if (process.env.NODE_ENV === "production" || optionalEnv("VERCEL") !== undefined ||
    resolveDatabaseTarget(optionalEnv("DATABASE_URL")).kind !== "pglite") {
    throw new Error("Local storage cleanup requires a local PGlite database and storage root.");
  }
  const result = await runStorageCleanupBatch(getDb(), new LocalFsStoragePurger());
  console.log(JSON.stringify(result));
}

main().catch(() => {
  console.error("Storage cleanup failed.");
  process.exitCode = 1;
});
