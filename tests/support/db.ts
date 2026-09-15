import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { applyMigrations } from "@/db/migrate";
import * as schema from "@/db/schema";

// Re-exported for tests' convenience; production code imports it from ./ids, never from here.
export { newId } from "@/db/ids";

/** The handle every test harness in this repo builds on: a Drizzle client over an isolated PGlite instance. */
export type TestDb = {
  db: PgliteDatabase<typeof schema>;
  // Raw access for tests that need plain SQL (client.query / client.exec).
  client: PGlite;
  close: () => Promise<void>;
};

// Migrated once per test worker, then cloned per createTestDb() call: a clone is ~3x faster than a
// fresh PGlite boot + migrate. The template is never handed out, so no test can mutate it.
let template: Promise<PGlite> | undefined;

async function createTemplate(): Promise<PGlite> {
  const client = new PGlite();
  await applyMigrations(client);
  return client;
}

/** A fresh, isolated, in-memory database with every migration applied. Call `t.close()` afterward — an unclosed clone keeps the test worker alive. */
export async function createTestDb(): Promise<TestDb> {
  template ??= createTemplate();
  const client = (await (await template).clone()) as PGlite;
  return { db: drizzle(client, { schema }), client, close: () => client.close() };
}
