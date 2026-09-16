import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { ConfigError, optionalEnv } from "../server/core/env";
import * as schema from "./schema";

/** The one database type every repository takes; both the PGlite and postgres.js drivers satisfy it. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Default local PGlite data directory, used when DATABASE_URL is unset. */
export const DEFAULT_PGLITE_DATA_DIR = ".pglite";

/** Pool size per instance: sized for in-instance concurrency, not 1 connection and not unbounded. */
export const POSTGRES_POOL_MAX = 5;

/** Never includes the offending value — DATABASE_URL carries the database password in prod. */
export const UNSUPPORTED_DATABASE_URL =
  "DATABASE_URL must be a postgres:// or postgresql:// URL, memory://, or a local PGlite directory path (value not shown: it may contain a password)";

const POSTGRES_SCHEME = /^postgres(ql)?:\/\//i;
const MEMORY_SCHEME = /^memory:\/\//i;

/** Where `createDb` connects: a postgres.js target or a PGlite data directory. */
export type DatabaseTarget = { kind: "postgres"; url: string } | { kind: "pglite"; dataDir: string };

/**
 * Parses DATABASE_URL into a target: postgres://, memory:// (PGlite), or a local PGlite directory
 * (default when unset). Any other scheme is rejected with a fixed message rather than handed to
 * PGlite as a path, whose errors would echo a mistyped URL's password.
 */
export function resolveDatabaseTarget(raw: string | undefined): DatabaseTarget {
  const value = raw?.trim();
  if (!value) return { kind: "pglite", dataDir: DEFAULT_PGLITE_DATA_DIR };
  if (POSTGRES_SCHEME.test(value)) {
    return { kind: "postgres", url: value.replace(POSTGRES_SCHEME, (scheme) => scheme.toLowerCase()) };
  }
  if (MEMORY_SCHEME.test(value)) return { kind: "pglite", dataDir: value.replace(MEMORY_SCHEME, "memory://") };
  if (value.includes("://")) throw new Error(UNSUPPORTED_DATABASE_URL);
  return { kind: "pglite", dataDir: value };
}

/** The ConfigError message when production has no postgres DATABASE_URL; never includes the value. */
export const PRODUCTION_DATABASE_URL_REQUIRED =
  "DATABASE_URL must be a postgres:// or postgresql:// URL in production (value not shown: it may contain a password)";

// Vercel sets VERCEL on every deployment, preview included, whatever NODE_ENV says.
function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || optionalEnv("VERCEL") !== undefined;
}

/**
 * Builds a fresh `Db` for the given DATABASE_URL (or the ambient env var, or the local PGlite). In
 * production anything but a postgres URL is a ConfigError: a missing variable must fail loudly, not
 * quietly write user data to a PGlite directory on an ephemeral serverless disk.
 */
export function createDb(databaseUrl: string | undefined = optionalEnv("DATABASE_URL")): Db {
  const target = resolveDatabaseTarget(databaseUrl);
  if (target.kind !== "postgres" && isProduction()) {
    const error = new ConfigError("DATABASE_URL");
    // ConfigError's own wording says "missing"; a set-but-local value needs this one.
    error.message = PRODUCTION_DATABASE_URL_REQUIRED;
    throw error;
  }
  if (target.kind === "postgres") {
    // prepare: false — Supavisor's transaction-mode pooler does not support prepared statements.
    return drizzlePostgres(postgres(target.url, { prepare: false, max: POSTGRES_POOL_MAX }), { schema });
  }
  return drizzlePglite(new PGlite(target.dataDir), { schema });
}

// Cached on globalThis, not a module-level variable: Next.js dev re-evaluates modules on HMR, and a
// second PGlite on the same dataDir corrupts it (and a second postgres.js pool leaks connections).
// Lazy, so importing this module never opens .pglite/ or a pool.
const cache = globalThis as typeof globalThis & { __lawyerUpDb?: Db };

/** The process-wide `Db` singleton, created lazily on first call. */
export function getDb(): Db {
  cache.__lawyerUpDb ??= createDb();
  return cache.__lawyerUpDb;
}
