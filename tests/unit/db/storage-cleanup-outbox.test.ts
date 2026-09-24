import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t?.close();
});

describe("storage cleanup outbox migration", () => {
  it("creates a storage_ref primary key and a timestamp with a database default", async () => {
    const columns = await t.client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'storage_cleanup_outbox'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: "storage_ref", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
      { column_name: "purged_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      { column_name: "next_attempt_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
      { column_name: "attempt_count", data_type: "integer", is_nullable: "NO", column_default: "0" },
    ]);
    const key = await t.client.query<{ definition: string; columns: string[] }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition,
              array_agg(a.attname ORDER BY k.ordinality) AS columns
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'public.storage_cleanup_outbox'::regclass
          AND c.conname = 'storage_cleanup_outbox_pkey' AND c.contype = 'p'
        GROUP BY c.oid`,
    );
    expect(key.rows).toEqual([{ definition: "PRIMARY KEY (storage_ref)", columns: ["storage_ref"] }]);
  });

  it("retains a queued ref without a document row and rejects duplicate refs", async () => {
    const [queued] = await t.db.insert(s.storageCleanupOutbox).values({ storageRef: "user/removed.pdf" }).returning();
    expect(queued.createdAt).toBeInstanceOf(Date);
    try {
      await t.db.insert(s.storageCleanupOutbox).values({ storageRef: "user/removed.pdf" });
      throw new Error("duplicate storage ref was accepted");
    } catch (error) {
      expect(((error as { cause?: { constraint?: string } }).cause)?.constraint).toBe("storage_cleanup_outbox_pkey");
    }
    expect(await t.db.select().from(s.storageCleanupOutbox)).toHaveLength(1);
  });
});
