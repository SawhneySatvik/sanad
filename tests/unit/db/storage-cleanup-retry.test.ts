import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS_DIR } from "@/db/migrate";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";

let t: TestDb | undefined;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function insertDocument(client: PGlite, ref: string): Promise<void> {
  await client.query(
    `INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, expires_at)
     VALUES ('guest-a', $1, 'lease.pdf', 'application/pdf', now() + interval '2 hours')`,
    [ref],
  );
}

describe("storage cleanup retry and tombstone migration", () => {
  it("keeps an existing queued ref pending, due, and at attempt zero after forward migration", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "saboot-outbox-0007-"));
    const client = new PGlite();
    try {
      for (const name of [
        "0001_core_schema.sql",
        "0002_rate_limits_and_cache.sql",
        "0003_comparisons_drafts_model_used.sql",
        "0004_drafts_jurisdiction.sql",
        "0005_titles_samples_updated_at.sql",
        "0006_storage_cleanup_outbox.sql",
      ]) {
        await copyFile(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
      }
      expect(await applyMigrations(client, dir)).toHaveLength(6);
      await client.exec("INSERT INTO storage_cleanup_outbox (storage_ref, created_at) VALUES ('guest-a/old.pdf', '2020-01-01T00:00:00Z')");

      expect(await applyMigrations(client, MIGRATIONS_DIR)).toEqual([
        "0007_storage_cleanup_retry_and_thread_index.sql",
        "0008_storage_objects.sql",
      ]);
      const result = await client.query<{ purged_at: string | null; due: boolean; attempt_count: number }>(
        `SELECT purged_at, next_attempt_at <= now() AS due, attempt_count
           FROM storage_cleanup_outbox WHERE storage_ref = 'guest-a/old.pdf'`,
      );
      expect(result.rows).toEqual([{ purged_at: null, due: true, attempt_count: 0 }]);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("selects only due pending refs; retry and tombstone states remain durable", async () => {
    const db = t!;
    await db.db.insert(s.storageCleanupOutbox).values([
      { storageRef: "guest-a/due.pdf" },
      { storageRef: "guest-a/later.pdf", nextAttemptAt: new Date(Date.now() + 60_000) },
      { storageRef: "guest-a/purged.pdf", purgedAt: new Date() },
    ]);
    const due = () => db.client.query<{ storage_ref: string }>(
      `SELECT storage_ref FROM storage_cleanup_outbox
        WHERE purged_at IS NULL AND next_attempt_at <= now()
        ORDER BY next_attempt_at, created_at, storage_ref LIMIT 10`,
    );
    expect((await due()).rows.map((r) => r.storage_ref)).toEqual(["guest-a/due.pdf"]);

    await db.client.exec(
      `UPDATE storage_cleanup_outbox
          SET next_attempt_at = now() + interval '1 minute', attempt_count = attempt_count + 1
        WHERE storage_ref = 'guest-a/due.pdf'`,
    );
    expect((await due()).rows).toEqual([]);
    const retry = await db.client.query<{ attempt_count: number; purged_at: string | null }>(
      "SELECT attempt_count, purged_at FROM storage_cleanup_outbox WHERE storage_ref = 'guest-a/due.pdf'",
    );
    expect(retry.rows).toEqual([{ attempt_count: 1, purged_at: null }]);

    await db.client.exec("UPDATE storage_cleanup_outbox SET purged_at = now() WHERE storage_ref = 'guest-a/due.pdf'");
    expect((await db.db.select().from(s.storageCleanupOutbox))).toHaveLength(3);
    await expect(db.client.exec("UPDATE storage_cleanup_outbox SET attempt_count = -1 WHERE storage_ref = 'guest-a/due.pdf'"))
      .rejects.toThrow("storage_cleanup_outbox_attempt_count_check");
  });

  it("rejects pending and purged refs case-insensitively with a fixed, nonsecret error", async () => {
    const db = t!;
    await db.db.insert(s.storageCleanupOutbox).values([
      { storageRef: "guest-a/Pending.pdf" },
      { storageRef: "guest-a/Purged.pdf", purgedAt: new Date() },
    ]);
    for (const ref of ["guest-a/pending.PDF", "guest-a/purged.PDF"]) {
      try {
        await insertDocument(db.client, ref);
        throw new Error("tombstoned ref was accepted");
      } catch (error) {
        const pg = error as { code?: string; constraint?: string; message: string };
        expect(pg.code).toBe("23514");
        expect(pg.constraint).toBe("documents_storage_ref_tombstone_guard");
        expect(pg.message).toContain("storage reference unavailable");
        expect(pg.message).not.toContain(ref);
      }
    }
    await insertDocument(db.client, "guest-a/fresh.pdf");
  });

  it("checks a tombstone after the old document's unique key is freed", async () => {
    const db = t!;
    await insertDocument(db.client, "guest-a/Old.pdf");
    try {
      await db.client.transaction(async (tx) => {
        await tx.exec("INSERT INTO storage_cleanup_outbox (storage_ref) VALUES ('guest-a/Old.pdf')");
        await tx.exec("DELETE FROM documents WHERE storage_ref = 'guest-a/Old.pdf'");
        await tx.query(
          `INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, expires_at)
           VALUES ('guest-a', 'guest-a/old.PDF', 'lease.pdf', 'application/pdf', now() + interval '2 hours')`,
        );
      });
      throw new Error("ref was reused after deletion");
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      expect(pg.code).toBe("23514");
      expect(pg.constraint).toBe("documents_storage_ref_tombstone_guard");
    }
  });

  it("registers an enabled row-level AFTER INSERT trigger on documents", async () => {
    const result = await t!.client.query<{ name: string; type: number; enabled: string; function_name: string }>(
      `SELECT t.tgname AS name, t.tgtype::int AS type, t.tgenabled AS enabled,
              p.proname AS function_name
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.documents'::regclass AND t.tgname = 'documents_storage_ref_tombstone_guard'`,
    );
    expect(result.rows).toEqual([{
      name: "documents_storage_ref_tombstone_guard",
      type: 5,
      enabled: "O",
      function_name: "documents_storage_ref_tombstone_guard",
    }]);
  });
});
