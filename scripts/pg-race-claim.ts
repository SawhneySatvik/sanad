/**
 * Opt-in race check for the guest → user claim: the real claimGuestData against the real guest-TTL
 * sweep, app_private.delete_expired_guest_rows() (prod-only/0002_m4_ttl_and_cleanup_functions.sql), on
 * separate Postgres connections with real row locks — PGlite runs one transaction at a time and
 * cannot exercise this. Needs a local Postgres; never part of npm test or check-all.
 *
 *   PG_RACE_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npx tsx scripts/pg-race-claim.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { MIGRATIONS_DIR } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { claimGuestData } from "../src/server/auth/claim";

type Sql = ReturnType<typeof postgres>;
type Fate = "claimed" | "deleted" | "guest-owned" | "user-owned-with-expiry";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// Every database and role this script creates is dropped again in main()'s finally block; nothing
// persists after a run.
const DATABASE_PREFIX = "t114_race_";
const USER_ID = "2a2a2a2a-0000-4000-8000-00000000000a";
const GUEST_ID = "claiming-guest";
const guest = { type: "guest" as const, guestSessionId: GUEST_ID };
const user = { type: "user" as const, userId: USER_ID };
const quiet = { onnotice: () => {} };

function localUrlOrExit(): URL {
  const raw = process.env.PG_RACE_DATABASE_URL;
  if (!raw) {
    console.log("pg-race-claim: skipped. Set PG_RACE_DATABASE_URL to a LOCAL postgres:// URL to run it.");
    process.exit(0);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo the value: it may carry a password.
    console.error("pg-race-claim: PG_RACE_DATABASE_URL is not a URL (value not shown).");
    process.exit(1);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    console.error("pg-race-claim: refusing to run. PG_RACE_DATABASE_URL must be a postgres:// URL on localhost.");
    process.exit(1);
  }
  return url;
}

function databaseUrl(base: URL, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(admin: Sql, base: URL, name: string): Promise<string> {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const setup = postgres(databaseUrl(base, name), { max: 1, ...quiet });
  try {
    // The same files, in the same order, as src/db/migrate.ts applies (top level only).
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
    for (const file of files) await setup.unsafe(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    await setup.unsafe(readFileSync(path.join(MIGRATIONS_DIR, "prod-only", "0002_m4_ttl_and_cleanup_functions.sql"), "utf8"));
  } finally {
    await setup.end();
  }
  return databaseUrl(base, name);
}

async function insertDraftChain(s: Sql, expiresAt: string, groundingDocumentId: string | null): Promise<string[]> {
  const ids: string[] = [];
  for (const revision of [1, 2, 3]) {
    const [row] = await s`
      INSERT INTO drafts (owner_guest_session_id, document_type, mode, grounding_document_id, content, revision_number, parent_draft_id, model_used, expires_at)
      VALUES (${GUEST_ID}, 'leave_and_license', ${groundingDocumentId ? "document_grounded" : "from_scratch"}, ${groundingDocumentId},
              ${`revision ${revision}`}, ${revision}, ${ids.at(-1) ?? null}, 'gemini-test', ${expiresAt})
      RETURNING id`;
    ids.push(row.id as string);
  }
  return ids;
}

interface GuestSet {
  documents: string[];
  comparisons: string[];
  drafts: string[];
}

// Every row on ONE expires_at, computed by the database clock, as LEAST() and chain inheritance produce.
// "full": two documents, a comparison of them, a 3-revision chain grounded on the first.
// "drafts-only": a 3-revision from-scratch chain and nothing else.
async function insertGuestSet(s: Sql, expiresAtSql: string, shape: "full" | "drafts-only"): Promise<GuestSet> {
  await s`INSERT INTO users (id, email) VALUES (${USER_ID}, 'claimer@example.com') ON CONFLICT DO NOTHING`;
  const [{ e }] = await s.unsafe(`SELECT (${expiresAtSql})::text AS e`);
  const expiresAt = e as string;
  if (shape === "drafts-only") {
    return { documents: [], comparisons: [], drafts: await insertDraftChain(s, expiresAt, null) };
  }
  const documents: string[] = [];
  for (const n of [1, 2]) {
    const [row] = await s`
      INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, expires_at)
      VALUES (${GUEST_ID}, ${`guest:${GUEST_ID}/0000000${n}-0000-4000-8000-000000000000/lease.txt`}, 'lease.txt', 'text/plain', ${expiresAt})
      RETURNING id`;
    documents.push(row.id as string);
  }
  const [comparison] = await s`
    INSERT INTO comparisons (owner_guest_session_id, document_a_id, document_b_id, model_used, expires_at)
    VALUES (${GUEST_ID}, ${documents[0]}, ${documents[1]}, 'gemini-test', ${expiresAt})
    RETURNING id`;
  return { documents, comparisons: [comparison.id as string], drafts: await insertDraftChain(s, expiresAt, documents[0]) };
}

async function fates(s: Sql, set: GuestSet): Promise<Fate[]> {
  const fate = async (table: string, id: string): Promise<Fate> => {
    const rows = await s.unsafe(`SELECT owner_user_id, owner_guest_session_id, expires_at FROM ${table} WHERE id = $1`, [id]);
    if (rows.length === 0) return "deleted";
    if (rows[0].owner_guest_session_id !== null) return "guest-owned";
    return rows[0].owner_user_id === USER_ID && rows[0].expires_at === null ? "claimed" : "user-owned-with-expiry";
  };
  return [
    ...(await Promise.all(set.comparisons.map((id) => fate("comparisons", id)))),
    ...(await Promise.all(set.drafts.map((id) => fate("drafts", id)))),
    ...(await Promise.all(set.documents.map((id) => fate("documents", id)))),
  ];
}

async function until(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// True when `waiter` is blocked on a lock that `holder` holds.
async function waitingOn(observer: Sql, waiter: number, holder: number): Promise<boolean> {
  const [row] = await observer`
    SELECT ${holder}::int = ANY (pg_blocking_pids(${waiter}::int)) AS blocked,
           (SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${waiter}::int) AS wait`;
  return row.blocked === true && row.wait === "Lock";
}

// Compared in SQL against the row itself: a JS Date would truncate expires_at to milliseconds.
async function expiredByDbClock(observer: Sql, set: GuestSet): Promise<boolean> {
  const [row] = await observer`SELECT now() > expires_at AS past FROM drafts WHERE id = ${set.drafts[0]}`;
  return row.past === true;
}

async function pidOf(s: Sql): Promise<number> {
  const [row] = await s`SELECT pg_backend_pid() AS pid`;
  return row.pid as number;
}

async function deadlockCount(observer: Sql): Promise<number> {
  await observer`SELECT pg_stat_clear_snapshot()`;
  const [row] = await observer`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`;
  return row.n as number;
}

// A connection holding FOR UPDATE on one row until released.
function gate(s: Sql, table: "documents" | "drafts", id: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = s.begin(async (tx) => {
    await tx.unsafe(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    locked();
    await released;
  });
  return { isLocked, release, done };
}

function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: string }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => {
      const e = error as { code?: string; cause?: { code?: string }; message?: string };
      return { error: e.cause?.code ?? e.code ?? e.message ?? String(error) };
    },
  );
}

interface Connections {
  claimer: Sql;
  sweeper: Sql;
  gater: Sql;
  observer: Sql;
}

interface Outcome {
  set: GuestSet;
  claim: { value?: unknown; error?: string };
  sweep: { value?: unknown; error?: string };
}

type Scenario = {
  name: string;
  expected: "claimed" | "deleted";
  run: (c: Connections, pids: { claimer: number; sweeper: number; gater: number }) => Promise<Outcome>;
};

function startSweep(sweeper: Sql) {
  // .then() starts it now: a postgres.js query is lazy until awaited or then()'d.
  return settle(sweeper`SELECT app_private.delete_expired_guest_rows() AS refs`.then((rows) => rows[0].refs as string[]));
}

// Each scenario pauses the real code mid-transaction with a third "gate" connection holding a row
// lock, confirmed via pg_blocking_pids() before it releases. PASS: every row lands in the one
// expected state (all claimed, or all deleted) and pg_stat_database.deadlocks did not move.
const SCENARIOS: Scenario[] = [
  {
    // Rows live when the claim's transaction starts (claim now() < e). The claim locks the comparison
    // and chain, then blocks on the gate at a document. The rows expire; the sweep starts (sweep now() >
    // e), matches them and must WAIT on the claim's locks, then skip what the claim re-owned.
    name: "claim holds locks, sweep waits",
    expected: "claimed",
    async run({ claimer, sweeper, gater, observer }, pids) {
      const set = await insertGuestSet(observer, "now() + interval '2 seconds'", "full");
      const g = gate(gater, "documents", set.documents[0]);
      await g.isLocked;
      const claim = settle(claimGuestData(drizzle(claimer, { schema }), guest, user));
      await until("claim blocked on the gate", () => waitingOn(observer, pids.claimer, pids.gater));
      await until("rows expired by the database clock", () => expiredByDbClock(observer, set));
      const sweep = startSweep(sweeper);
      await until("sweep blocked on the claim", () => waitingOn(observer, pids.sweeper, pids.claimer));
      console.log("  observed: sweep waiting on the claim's row lock");
      g.release();
      await g.done;
      return { set, claim: await claim, sweep: await sweep };
    },
  },
  {
    // Same timing, but the SWEEP locks first: it deletes the comparison and chain and blocks on the gate
    // at a document. A claim whose transaction began before expiry then WAITS on the sweep's locks and,
    // once the sweep commits, finds the rows gone.
    name: "sweep holds locks, claim waits",
    expected: "deleted",
    async run({ claimer, sweeper, gater, observer }, pids) {
      const set = await insertGuestSet(observer, "now() + interval '2 seconds'", "full");
      let proceed!: () => void;
      const mayProceed = new Promise<void>((resolve) => (proceed = resolve));
      let began!: () => void;
      const claimBegan = new Promise<void>((resolve) => (began = resolve));
      const db = drizzle(claimer, { schema });
      const claim = settle(
        db.transaction(async (tx) => {
          // Fixes this transaction's now() before the rows expire.
          await tx.execute(sql`SELECT now()`);
          began();
          await mayProceed;
          return claimGuestData(tx, guest, user);
        }),
      );
      await claimBegan;
      const g = gate(gater, "documents", set.documents[0]);
      await g.isLocked;
      await until("rows expired by the database clock", () => expiredByDbClock(observer, set));
      const sweep = startSweep(sweeper);
      await until("sweep blocked on the gate", () => waitingOn(observer, pids.sweeper, pids.gater));
      proceed();
      await until("claim blocked on the sweep", () => waitingOn(observer, pids.claimer, pids.sweeper));
      console.log("  observed: claim waiting on the sweep's row lock");
      g.release();
      await g.done;
      return { set, claim: await claim, sweep: await sweep };
    },
  },
  {
    // The rows expired BEFORE the claim began (e < claim now()), and no sweep has run yet. The claim goes
    // first with the sweep concurrent. Its in-transaction re-check must decline every row; the sweep then
    // deletes them. (Remove the re-check and the claim resurrects them: this scenario fails.)
    name: "expired before the claim, sweep concurrent",
    expected: "deleted",
    async run({ claimer, sweeper, gater, observer }, pids) {
      const set = await insertGuestSet(observer, "now() - interval '1 minute'", "full");
      const g = gate(gater, "documents", set.documents[0]);
      await g.isLocked;
      let claimFinished = false;
      const claim = settle(claimGuestData(drizzle(claimer, { schema }), guest, user)).finally(() => (claimFinished = true));
      await until("claim finished or blocked on the gate", async () => claimFinished || (await waitingOn(observer, pids.claimer, pids.gater)));
      console.log(`  observed: claim ${claimFinished ? "finished without touching a row" : "blocked on the gate, holding locks"}`);
      const sweep = startSweep(sweeper);
      await until(
        "sweep blocked",
        async () => (await waitingOn(observer, pids.sweeper, pids.gater)) || (await waitingOn(observer, pids.sweeper, pids.claimer)),
      );
      g.release();
      await g.done;
      return { set, claim: await claim, sweep: await sweep };
    },
  },
  {
    // A from-scratch chain R1 ← R2 ← R3, expiring during the claim. The gate holds R2: the claim locks
    // R3 first (the sweep's order), then blocks on R2, so the sweep's pass waits on the claim for R3.
    // Locked root-first instead, the claim would hold R1 while the sweep holds R3 and wants R2: a deadlock.
    name: "drafts-only chain, claim now() < e < sweep now()",
    expected: "claimed",
    async run({ claimer, sweeper, gater, observer }, pids) {
      const set = await insertGuestSet(observer, "now() + interval '2 seconds'", "drafts-only");
      const g = gate(gater, "drafts", set.drafts[1]);
      await g.isLocked;
      const claim = settle(claimGuestData(drizzle(claimer, { schema }), guest, user));
      await until("claim blocked on the gate at R2", () => waitingOn(observer, pids.claimer, pids.gater));
      await until("rows expired by the database clock", () => expiredByDbClock(observer, set));
      const sweep = startSweep(sweeper);
      await until(
        "sweep blocked",
        async () => (await waitingOn(observer, pids.sweeper, pids.claimer)) || (await waitingOn(observer, pids.sweeper, pids.gater)),
      );
      console.log(`  observed: sweep waiting on the ${(await waitingOn(observer, pids.sweeper, pids.claimer)) ? "claim" : "gate"}`);
      g.release();
      await g.done;
      return { set, claim: await claim, sweep: await sweep };
    },
  },
];

async function main(): Promise<void> {
  const base = localUrlOrExit();
  console.log(`pg-race-claim: local Postgres at ${base.hostname}:${base.port || "5432"}`);
  // Needs a role that can CREATE DATABASE and CREATE ROLE.
  const admin = postgres(base.toString(), { max: 1, ...quiet });
  const createdRoles: string[] = [];
  const databases: string[] = [];
  let failures = 0;
  try {
    const [{ version }] = await admin`SELECT current_setting('server_version') AS version`;
    console.log(`server_version ${version}`);
    // Local stand-ins for the anon/authenticated roles that migration's REVOKEs name, only created if
    // the cluster doesn't already have them.
    for (const role of ["anon", "authenticated"]) {
      const [exists] = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
      if (!exists) {
        await admin.unsafe(`CREATE ROLE ${role} NOLOGIN`);
        createdRoles.push(role);
      }
    }

    for (const [index, scenario] of SCENARIOS.entries()) {
      console.log(`\n=== ${index + 1}. ${scenario.name}`);
      const name = `${DATABASE_PREFIX}${index + 1}`;
      databases.push(name);
      const url = await freshDatabase(admin, base, name);
      const c: Connections = {
        claimer: postgres(url, { max: 1, prepare: false, ...quiet }),
        sweeper: postgres(url, { max: 1, ...quiet }),
        gater: postgres(url, { max: 1, ...quiet }),
        observer: postgres(url, { max: 1, ...quiet }),
      };
      let outcome: Outcome;
      let deadlocksBefore: number;
      try {
        deadlocksBefore = await deadlockCount(c.observer);
        const pids = { claimer: await pidOf(c.claimer), sweeper: await pidOf(c.sweeper), gater: await pidOf(c.gater) };
        outcome = await scenario.run(c, pids);
      } finally {
        await Promise.all([c.claimer.end(), c.sweeper.end(), c.gater.end()]);
      }
      // A deadlock victim's report reaches pg_stat_database asynchronously: give it a moment.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const deadlocks = (await deadlockCount(c.observer)) - deadlocksBefore;
      const final = await fates(c.observer, outcome.set);
      await c.observer.end();

      console.log(`  claim: ${JSON.stringify(outcome.claim)}`);
      console.log(`  sweep: ${JSON.stringify(outcome.sweep)}`);
      console.log(`  deadlocks: ${deadlocks}`);
      console.log(`  final: ${JSON.stringify(final)}`);
      const pass = deadlocks === 0 && outcome.sweep.error === undefined && outcome.claim.error === undefined && final.every((f) => f === scenario.expected);
      console.log(pass ? `  PASS: every row ${scenario.expected}, no deadlock` : `  FAIL: expected every row ${scenario.expected} and no deadlock`);
      if (!pass) failures++;
    }
  } finally {
    // WITH (FORCE) (Postgres 13+): a scenario that timed out may have left a connection open.
    for (const name of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    for (const role of createdRoles) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
  console.log(`\npg-race-claim: ${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios passed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
