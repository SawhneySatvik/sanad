import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "@/db/migrate";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";

// The prod-only migrations (M3, M4) are never applied by db:migrate or createTestDb. These tests apply
// them to a throwaway in-memory database: M3's table/function lists against the schema and its
// post-condition against stand-in roles; M4 part 1's leaf-first TTL delete ordering and pruning.

const PROD_ONLY = path.join(MIGRATIONS_DIR, "prod-only");
const M3 = readFileSync(path.join(PROD_ONLY, "0001_m3_revoke_data_api_grants.sql"), "utf8");
const M4_FUNCTIONS = readFileSync(path.join(PROD_ONLY, "0002_m4_ttl_and_cleanup_functions.sql"), "utf8");
const OUTBOX_REVOKE = readFileSync(path.join(PROD_ONLY, "0004_storage_cleanup_outbox_revoke_data_api_grants.sql"), "utf8");
const GUARD_REVOKE = readFileSync(path.join(PROD_ONLY, "0005_documents_storage_ref_tombstone_guard_revoke.sql"), "utf8");
const STORAGE_OBJECTS_REVOKE = readFileSync(path.join(PROD_ONLY, "0006_storage_objects_revoke_data_api_grants.sql"), "utf8");

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

async function createStandInRoles(): Promise<void> {
  await t.client.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;");
}

describe("M3 (prod-only) — deny-all Data API grants", () => {
  it("every prod-only file carries the required header on its first line", () => {
    for (const file of readdirSync(PROD_ONLY).filter((name) => name.endsWith(".sql"))) {
      const firstLine = readFileSync(path.join(PROD_ONLY, file), "utf8").split("\n")[0];
      expect(firstLine, file).toBe("-- prod-only; requires Supabase; never applied by db:migrate or the test harness");
    }
  });

  it("the union of prod-only files revokes by name every public table (incl. schema_migrations)", async () => {
    const revoked = readdirSync(PROD_ONLY)
      .filter((name) => name.endsWith(".sql"))
      .flatMap((name) => [...readFileSync(path.join(PROD_ONLY, name), "utf8").matchAll(/^REVOKE ALL ON TABLE public\.(\w+) FROM PUBLIC, anon, authenticated;$/gm)].map((m) => m[1]));
    const tables = await t.client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    expect(revoked.sort()).toEqual(tables.rows.map((r) => r.table_name).sort());
    expect(revoked).toHaveLength(21);
  });

  it("the union of prod-only files revokes by name every app function", async () => {
    const revoked = readdirSync(PROD_ONLY)
      .filter((name) => name.endsWith(".sql"))
      .flatMap((name) => [...readFileSync(path.join(PROD_ONLY, name), "utf8").matchAll(/^REVOKE ALL ON FUNCTION public\.(\w+)\(\) FROM PUBLIC, anon, authenticated;$/gm)].map((m) => m[1]));
    // Extension-owned functions excluded, as in M3's own post-condition: on PGlite, CREATE EXTENSION
    // vector installs into public, and those are not app functions.
    const functions = await t.client.query<{ proname: string }>(
      `SELECT proname FROM pg_proc p
        WHERE pronamespace = 'public'::regnamespace
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
    );
    expect(revoked.sort()).toEqual(functions.rows.map((r) => r.proname).sort());
    expect(revoked).toHaveLength(6);
  });

  it("after the named revokes, neither stand-in role holds any table or function privilege", async () => {
    // A real anon-key PostgREST denial test needs an actual Supabase project; this checks the SQL
    // against stand-in roles instead.
    await createStandInRoles();
    // Simulate the old platform default M3 defends against: everything granted to the API roles.
    await t.client.exec(`
      GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
    `);
    // The historical M3 file is frozen; the new function's separate forward revoke must run before
    // replaying M3 against this already-current schema in the throwaway database.
    await t.client.exec(GUARD_REVOKE);
    await t.client.exec(M3);
    const leaks = await t.client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated')) r (rolname)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE')`,
    );
    expect(leaks.rows[0].n).toBe(0);
    // Positive control: the owning role (what the app connects as) keeps full access.
    const owner = await t.client.query<{ ok: boolean }>("SELECT has_table_privilege('postgres', 'public.documents', 'SELECT, INSERT') AS ok");
    expect(owner.rows[0].ok).toBe(true);
  });

  it("the outbox revoke removes table and column access from both stand-in Data API roles", async () => {
    await createStandInRoles();
    await t.client.exec("GRANT ALL ON public.storage_cleanup_outbox TO PUBLIC, anon, authenticated");
    await t.client.exec(OUTBOX_REVOKE);
    const denied = await t.client.query<{ role: string; table_access: boolean; column_access: boolean }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.storage_cleanup_outbox',
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS table_access,
              has_any_column_privilege(r.role, 'public.storage_cleanup_outbox',
                'SELECT, INSERT, UPDATE, REFERENCES') AS column_access
         FROM (VALUES ('anon'), ('authenticated')) AS r(role)
        ORDER BY r.role`,
    );
    expect(denied.rows).toEqual([
      { role: "anon", table_access: false, column_access: false },
      { role: "authenticated", table_access: false, column_access: false },
    ]);
    const owner = await t.client.query<{ ok: boolean }>(
      "SELECT has_table_privilege('postgres', 'public.storage_cleanup_outbox', 'SELECT, INSERT, DELETE') AS ok",
    );
    expect(owner.rows[0].ok).toBe(true);
  });

  it("the outbox post-condition fails when an API role still has access", async () => {
    await createStandInRoles();
    await t.client.exec("GRANT SELECT ON public.storage_cleanup_outbox TO anon");
    const postCondition = OUTBOX_REVOKE.slice(OUTBOX_REVOKE.indexOf("DO $$"));
    await expect(t.client.exec(postCondition)).rejects.toThrow(
      "storage cleanup outbox post-condition failed: Data API roles still hold privileges: anon",
    );
  });

  it("the storage objects revoke removes table and column access from both stand-in Data API roles", async () => {
    await createStandInRoles();
    await t.client.exec("GRANT ALL ON public.storage_objects TO PUBLIC, anon, authenticated");
    await t.client.exec(STORAGE_OBJECTS_REVOKE);
    const denied = await t.client.query<{ role: string; table_access: boolean; column_access: boolean }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.storage_objects',
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS table_access,
              has_any_column_privilege(r.role, 'public.storage_objects',
                'SELECT, INSERT, UPDATE, REFERENCES') AS column_access
         FROM (VALUES ('anon'), ('authenticated')) AS r(role)
        ORDER BY r.role`,
    );
    expect(denied.rows).toEqual([
      { role: "anon", table_access: false, column_access: false },
      { role: "authenticated", table_access: false, column_access: false },
    ]);
    const owner = await t.client.query<{ ok: boolean }>(
      "SELECT has_table_privilege('postgres', 'public.storage_objects', 'SELECT, INSERT, DELETE') AS ok",
    );
    expect(owner.rows[0].ok).toBe(true);
  });

  it("the storage objects post-condition fails when an API role still has access", async () => {
    await createStandInRoles();
    await t.client.exec("GRANT SELECT ON public.storage_objects TO anon");
    const postCondition = STORAGE_OBJECTS_REVOKE.slice(STORAGE_OBJECTS_REVOKE.indexOf("DO $$"));
    await expect(t.client.exec(postCondition)).rejects.toThrow(
      "storage objects post-condition failed: Data API roles still hold privileges: anon",
    );
  });

  it("the tombstone guard revoke removes EXECUTE from both stand-in Data API roles", async () => {
    await createStandInRoles();
    await t.client.exec("GRANT EXECUTE ON FUNCTION public.documents_storage_ref_tombstone_guard() TO PUBLIC, anon, authenticated");
    await t.client.exec(GUARD_REVOKE);
    const denied = await t.client.query<{ role: string; can_execute: boolean }>(
      `SELECT r.role,
              has_function_privilege(r.role, 'public.documents_storage_ref_tombstone_guard()', 'EXECUTE') AS can_execute
         FROM (VALUES ('anon'), ('authenticated')) AS r(role)
        ORDER BY r.role`,
    );
    expect(denied.rows).toEqual([
      { role: "anon", can_execute: false },
      { role: "authenticated", can_execute: false },
    ]);
    const owner = await t.client.query<{ ok: boolean }>(
      "SELECT has_function_privilege('postgres', 'public.documents_storage_ref_tombstone_guard()', 'EXECUTE') AS ok",
    );
    expect(owner.rows[0].ok).toBe(true);
  });

  it("the tombstone guard post-condition fails if a Data API role retains EXECUTE", async () => {
    await createStandInRoles();
    await t.client.exec("GRANT EXECUTE ON FUNCTION public.documents_storage_ref_tombstone_guard() TO anon");
    const postCondition = GUARD_REVOKE.slice(GUARD_REVOKE.indexOf("DO $$"));
    await expect(t.client.exec(postCondition)).rejects.toThrow(
      "storage ref guard post-condition failed: Data API roles can execute function: anon",
    );
  });

  it("smoke: M3's post-condition block fails loudly when a single grant survives", async () => {
    await createStandInRoles();
    await t.client.exec(M3);
    await t.client.exec("GRANT SELECT ON public.documents TO anon");
    const postCondition = M3.slice(M3.indexOf("DO $$"));
    await expect(t.client.exec(postCondition)).rejects.toThrow(
      "M3 post-condition failed: Data API roles still hold table privileges: anon.documents",
    );
  });
});

describe("M4 part 1 (prod-only) — guest TTL sweep ordering and pruning", () => {
  const past = () => new Date(Date.now() - 60_000);
  const future = () => new Date(Date.now() + 3_600_000);

  async function guestDocument(storageRef: string, expiresAt: Date | null, owner: "guest" | string = "guest") {
    const [row] = await t.db
      .insert(s.documents)
      .values({
        ownerGuestSessionId: owner === "guest" ? "guest-a" : null,
        ownerUserId: owner === "guest" ? null : owner,
        storageRef,
        filename: "f.pdf",
        mimeType: "application/pdf",
        inputMode: "text",
        processingStatus: "ready",
        canonicalText: "text",
        canonicalTextHash: "h",
        extractorVersion: "x@1",
        expiresAt,
      })
      .returning();
    return row;
  }

  async function sweep(): Promise<string[]> {
    const result = await t.client.query<{ refs: string[] }>("SELECT app_private.delete_expired_guest_rows() AS refs");
    return result.rows[0].refs;
  }

  beforeEach(async () => {
    await createStandInRoles();
    await t.client.exec(M4_FUNCTIONS);
  });

  it("deletes comparisons, then a 3-revision draft chain newest-first, then documents — with every expires_at tied", async () => {
    const expiry = past();
    const a = await guestDocument("guest-a/1/a.pdf", expiry);
    const b = await guestDocument("guest-a/2/b.pdf", expiry);
    const [analysis] = await t.db.insert(s.analyses).values({ documentId: a.id, promptVersion: "p", modelUsed: "m" }).returning();
    await t.db.insert(s.findings).values({
      documentId: a.id,
      analysisId: analysis.id,
      category: "obligation",
      modelUsed: "m",
      explanation: "e",
    });
    await t.db.insert(s.comparisons).values({ ownerGuestSessionId: "guest-a", documentAId: a.id, documentBId: b.id, expiresAt: expiry, modelUsed: "m" });
    const draft = { ownerGuestSessionId: "guest-a", documentType: "grounded_response", mode: "document_grounded" as const, content: "c", expiresAt: expiry, modelUsed: "m" };
    const [r1] = await t.db.insert(s.drafts).values({ ...draft, groundingDocumentId: a.id, revisionNumber: 1 }).returning();
    const [r2] = await t.db.insert(s.drafts).values({ ...draft, groundingDocumentId: a.id, revisionNumber: 2, parentDraftId: r1.id }).returning();
    await t.db.insert(s.drafts).values({ ...draft, groundingDocumentId: a.id, revisionNumber: 3, parentDraftId: r2.id });

    expect(await sweep()).toEqual(["guest-a/1/a.pdf", "guest-a/2/b.pdf"]);
    expect(await t.db.select().from(s.comparisons)).toHaveLength(0);
    expect(await t.db.select().from(s.drafts)).toHaveLength(0);
    expect(await t.db.select().from(s.documents)).toHaveLength(0);
    expect(await t.db.select().from(s.findings)).toHaveLength(0);
  });

  it("keeps unexpired guest rows, user-owned rows (even with a past expires_at), and RESTRICT-blocked documents", async () => {
    const userId = "0199aaaa-0000-7000-8000-000000000001";
    await t.db.insert(s.users).values({ id: userId, email: "u@example.com" });
    const live = await guestDocument("guest-a/live.pdf", future());
    const claimed = await guestDocument("user/claimed.pdf", past(), userId);
    const blocked = await guestDocument("guest-a/blocked.pdf", past());
    const expired = await guestDocument("guest-a/expired.pdf", past());
    // A comparison that has not expired yet still needs `blocked` (it outlives the document, which the
    // LEAST() cap should prevent — this is the defensive path): the sweep must skip it, not abort.
    await t.db
      .insert(s.comparisons)
      .values({ ownerGuestSessionId: "guest-a", documentAId: blocked.id, documentBId: live.id, expiresAt: future(), modelUsed: "m" });

    expect(await sweep()).toEqual(["guest-a/expired.pdf"]);
    const remaining = (await t.db.select({ id: s.documents.id }).from(s.documents)).map((r) => r.id).sort();
    expect(remaining).toEqual([live.id, claimed.id, blocked.id].sort());
    expect(await t.db.select().from(s.documents).where(eq(s.documents.id, expired.id))).toHaveLength(0);
  });

  it("never returns (so never purges) a storage_ref a surviving row still points at, even if the uniqueness guards were relaxed", async () => {
    const userId = "0199aaaa-0000-7000-8000-000000000002";
    await t.db.insert(s.users).values({ id: userId, email: "u2@example.com" });
    // Positive control: with no surviving row on the ref, the expired guest row's bytes ARE purged.
    await guestDocument("guest-a/solo/a.pdf", past());
    expect(await sweep()).toEqual(["guest-a/solo/a.pdf"]);

    // Simulate the two uniqueness guards being relaxed, then a claimed user's row sharing (a
    // case-variant of) an expired guest row's ref.
    await t.client.exec("ALTER TABLE documents DROP CONSTRAINT documents_storage_ref_key; DROP INDEX documents_storage_ref_lower_key;");
    const expired = await guestDocument("guest-a/shared/Lease.pdf", past());
    const claimed = await guestDocument("guest-a/shared/lease.pdf", null, userId);
    expect(await sweep()).toEqual([]);
    expect(await t.db.select().from(s.documents).where(eq(s.documents.id, expired.id))).toHaveLength(0);
    expect(await t.db.select().from(s.documents).where(eq(s.documents.id, claimed.id))).toHaveLength(1);
  });

  it("the docs' literal 'oldest-revision-first' order would violate drafts_parent_draft_id_fkey (why the sweep goes newest-first)", async () => {
    const draft = { ownerGuestSessionId: "guest-a", documentType: "leave_and_license", mode: "from_scratch" as const, content: "c", expiresAt: past(), modelUsed: "m" };
    const [r1] = await t.db.insert(s.drafts).values({ ...draft, revisionNumber: 1 }).returning();
    await t.db.insert(s.drafts).values({ ...draft, revisionNumber: 2, parentDraftId: r1.id });
    await expect(t.client.query("DELETE FROM drafts WHERE id = $1", [r1.id])).rejects.toThrow(
      'violates RESTRICT setting of foreign key constraint "drafts_parent_draft_id_fkey"',
    );
  });

  it("prunes expired cache rows and rate-limit rows older than 2 days; keeps the rest", async () => {
    await t.db.insert(s.analyzedResultCache).values([
      { cacheKey: "old", rawModelOutput: "{}", modelUsed: "m", expiresAt: past() },
      { cacheKey: "fresh", rawModelOutput: "{}", modelUsed: "m", expiresAt: future() },
    ]);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    await t.db.insert(s.rateLimitBuckets).values([
      { principalKey: "guest:old", windowKey: "w", requestCount: 1, updatedAt: threeDaysAgo },
      { principalKey: "guest:new", windowKey: "w", requestCount: 1 },
    ]);
    await t.db.insert(s.ipRateLimitBuckets).values({ ipKey: "old", windowKey: "w", requestCount: 1, updatedAt: threeDaysAgo });
    await t.db.insert(s.globalLlmRateLimit).values({ providerKey: "gemini", windowKey: "w", requestCount: 1, updatedAt: threeDaysAgo });

    await t.client.exec("SELECT app_private.prune_rate_limits_and_cache()");

    expect((await t.db.select().from(s.analyzedResultCache)).map((r) => r.cacheKey)).toEqual(["fresh"]);
    expect((await t.db.select().from(s.rateLimitBuckets)).map((r) => r.principalKey)).toEqual(["guest:new"]);
    expect(await t.db.select().from(s.ipRateLimitBuckets)).toHaveLength(0);
    expect(await t.db.select().from(s.globalLlmRateLimit)).toHaveLength(0);
  });
});

describe("guest TTL sweep over Postgres-stored bytes (prod-only 0007)", () => {
  // PGlite has no pg_cron, so only the function definition and its revoke run here; the schedule and
  // its post-condition are Supabase-only.
  const SWEEP_0007 = readFileSync(path.join(PROD_ONLY, "0007_guest_ttl_sweep_postgres_storage.sql"), "utf8");
  const functionSql = SWEEP_0007.slice(
    SWEEP_0007.indexOf("CREATE OR REPLACE FUNCTION"),
    SWEEP_0007.indexOf("-- Every 5 minutes"),
  );

  async function document(storageRef: string, expiresAt: Date | null) {
    await t.db.insert(s.documents).values({
      ownerGuestSessionId: "guest-a",
      storageRef,
      filename: "f.txt",
      mimeType: "text/plain",
      inputMode: "text",
      processingStatus: "ready",
      canonicalText: "text",
      canonicalTextHash: "h",
      extractorVersion: "x@1",
      expiresAt,
    });
  }

  async function storedObject(storageRef: string, ageMinutes: number) {
    await t.client.query(
      "INSERT INTO storage_objects (storage_ref, owner_principal_key, declared_size_bytes, bytes, created_at) VALUES ($1, 'guest:guest-a', 4, '\\x74657374', now() - make_interval(mins => $2))",
      [storageRef, ageMinutes],
    );
  }

  async function storedRefs(): Promise<string[]> {
    const result = await t.client.query<{ storage_ref: string }>("SELECT storage_ref FROM storage_objects ORDER BY storage_ref");
    return result.rows.map((row) => row.storage_ref);
  }

  beforeEach(async () => {
    await createStandInRoles();
    await t.client.exec(M4_FUNCTIONS);
    await t.client.exec(functionSql);
  });

  it("deletes an expired guest document's bytes with its row, and keeps a live document's bytes", async () => {
    await document("guest-a/expired.txt", new Date(Date.now() - 60_000));
    await document("guest-a/live.txt", new Date(Date.now() + 3_600_000));
    await storedObject("guest-a/expired.txt", 5);
    await storedObject("guest-a/live.txt", 5);

    await t.client.query("SELECT app_private.run_guest_ttl_sweep()");

    expect(await storedRefs()).toEqual(["guest-a/live.txt"]);
    expect(await t.db.select().from(s.documents)).toHaveLength(1);
  });

  it("deletes old unreferenced bytes and their outbox entry, but never a recent upload still in flight", async () => {
    await storedObject("guest-a/abandoned.txt", 120);
    await storedObject("guest-a/in-flight.txt", 1);
    await t.client.query("INSERT INTO storage_cleanup_outbox (storage_ref) VALUES ('guest-a/abandoned.txt')");

    await t.client.query("SELECT app_private.run_guest_ttl_sweep()");

    expect(await storedRefs()).toEqual(["guest-a/in-flight.txt"]);
    const outbox = await t.client.query("SELECT storage_ref FROM storage_cleanup_outbox");
    expect(outbox.rows).toHaveLength(0);
  });
});
