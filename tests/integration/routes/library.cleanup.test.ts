import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import * as document from "@/app/api/documents/[id]/route";
import * as deleteAll from "@/app/api/me/data/route";
import { deleteLibraryRow, processQueuedStorageRef } from "@/server/data/library";
import { createPendingDocument } from "@/server/data/documents";
import { buildRef } from "@/server/storage/refs";
import { runStorageCleanupBatch } from "@/server/storage/cleanup-worker";
import type { StoragePurger } from "@/server/storage/types";
import { insertDocument } from "@tests/support/auth/claim";
import { callRoute, createRouteHarness, request, userA, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => { h = await createRouteHarness(); h.signIn(userA); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

async function removeDocument(id: string) {
  return callRoute(document.DELETE, request("DELETE", `/api/documents/${id}`), { id });
}

function fakePurger(purge: StoragePurger["purge"]): StoragePurger {
  return { purge, purgeUnconfirmedUploads: async () => 0 };
}

describe("explicit-delete storage cleanup", () => {
  it("acknowledges an immediate adapter deletion after the DB commit", async () => {
    const row = await insertDocument(h.t, userA, null);
    const deletion = vi.spyOn(h.storage, "delete").mockResolvedValueOnce();
    expect((await removeDocument(row.id)).status).toBe(204);
    expect(deletion).toHaveBeenCalledOnce();
    expect((await h.t.db.select().from(schema.storageCleanupOutbox))[0].purgedAt).not.toBeNull();
    expect(await h.t.db.select().from(schema.documents)).toHaveLength(0);
  });

  it("rolls back a queued ref if the document delete fails", async () => {
    const row = await insertDocument(h.t, userA, null);
    await h.t.client.exec(`
      CREATE FUNCTION reject_document_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'delete rejected'; END;
      $$;
      CREATE TRIGGER reject_document_delete_trigger BEFORE DELETE ON documents
        FOR EACH ROW EXECUTE FUNCTION reject_document_delete();
    `);
    await expect(deleteLibraryRow(h.t.db, userA, "document", row.id)).rejects.toThrow();
    expect(await h.t.db.select().from(schema.storageCleanupOutbox)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.documents)).toHaveLength(1);
  });

  it("queues every delete-all ref when immediate storage deletion fails", async () => {
    const rows = await Promise.all([insertDocument(h.t, userA, null), insertDocument(h.t, userA, null)]);
    const hostile = "private/path?token=secret-value";
    vi.spyOn(h.storage, "delete").mockRejectedValue(new Error(hostile));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await callRoute(deleteAll.DELETE, request("DELETE", "/api/me/data"));
    expect(response.status).toBe(200);
    expect((await response.json()).deleted.documents).toBe(2);
    expect((await h.t.db.select().from(schema.storageCleanupOutbox)).map((entry) => entry.storageRef).sort())
      .toEqual(rows.map((row) => row.storageRef).sort());
    expect(JSON.stringify(logged.mock.calls)).not.toContain(hostile);
    expect(logged.mock.calls.every((call) => call.length === 1 && call[0] === "Document object deletion deferred to purger.")).toBe(true);
    const purge = vi.fn(async () => undefined);
    await h.t.db.update(schema.storageCleanupOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge))).toEqual({ selected: 2, purged: 2, live: 0, failed: 0 });
    expect((await h.t.db.select().from(schema.storageCleanupOutbox)).every((entry) => entry.purgedAt !== null)).toBe(true);
  });

  it("keeps failures durable across worker retries and duplicate purges", async () => {
    const row = await insertDocument(h.t, userA, null);
    vi.spyOn(h.storage, "delete").mockRejectedValueOnce(new Error("object unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await removeDocument(row.id)).status).toBe(204);
    expect((await h.t.db.select().from(schema.storageCleanupOutbox))[0].storageRef).toBe(row.storageRef);
    const failedPurge = vi.fn(async () => { throw new Error("storage unavailable"); });
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(failedPurge))).toEqual({ selected: 0, purged: 0, live: 0, failed: 0 });
    await h.t.db.update(schema.storageCleanupOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(failedPurge))).toEqual({ selected: 1, purged: 0, live: 0, failed: 1 });
    const [failed] = await h.t.db.select().from(schema.storageCleanupOutbox);
    expect(failed.attemptCount).toBeGreaterThanOrEqual(1);
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    const purge = vi.fn(async () => undefined);
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge))).toEqual({ selected: 0, purged: 0, live: 0, failed: 0 });
    await h.t.db.update(schema.storageCleanupOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge))).toEqual({ selected: 1, purged: 1, live: 0, failed: 0 });
    expect(purge).toHaveBeenCalledWith([row.storageRef]);
    expect((await h.t.db.select().from(schema.storageCleanupOutbox))[0].purgedAt).not.toBeNull();
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge))).toEqual({ selected: 0, purged: 0, live: 0, failed: 0 });
  });

  it("does not purge a queued ref while a case-insensitive live alias exists", async () => {
    const row = await insertDocument(h.t, userA, null);
    vi.spyOn(h.storage, "delete").mockRejectedValueOnce(new Error("object unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await removeDocument(row.id)).status).toBe(204);
    const replacement = await insertDocument(h.t, userA, null);
    await h.t.db.update(schema.documents).set({ storageRef: row.storageRef.replace("/lease.txt", "/LEASE.txt") })
      .where(eq(schema.documents.id, replacement.id));
    const purge = vi.fn(async () => undefined);
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge))).toEqual({ selected: 0, purged: 0, live: 0, failed: 0 });
    expect(await processQueuedStorageRef(h.t.db, row.storageRef, () => purge())).toBe("live");
    expect(purge).not.toHaveBeenCalled();
    expect(await h.t.db.select().from(schema.storageCleanupOutbox)).toHaveLength(1);
  });

  it("rejects a queued or purged ref even when its case changes", async () => {
    const row = await insertDocument(h.t, userA, null);
    vi.spyOn(h.storage, "delete").mockRejectedValueOnce(new Error("object unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await removeDocument(row.id)).status).toBe(204);
    const reused = { storageRef: row.storageRef.replace("/lease.txt", "/LEASE.txt"), filename: "LEASE.txt", mimeType: "text/plain" };
    await expect(createPendingDocument(h.t.db, userA, reused)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await h.t.db.select().from(schema.documents)).toHaveLength(0);
    await h.t.db.update(schema.storageCleanupOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    const purge = vi.fn(async () => undefined);
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge))).toEqual({ selected: 1, purged: 1, live: 0, failed: 0 });
    await expect(createPendingDocument(h.t.db, userA, reused)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await h.t.db.select().from(schema.documents)).toHaveLength(0);
  });

  it("rejects ref reuse injected after the worker's live check and before purge", async () => {
    const row = await insertDocument(h.t, userA, null);
    vi.spyOn(h.storage, "delete").mockRejectedValueOnce(new Error("object unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await removeDocument(row.id)).status).toBe(204);
    const purge = vi.fn(async () => undefined);
    let injectionError: unknown;
    const outcome = await processQueuedStorageRef(h.t.db, row.storageRef, async (tx) => {
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.insert(schema.documents).values({ ownerUserId: userA.userId,
            storageRef: row.storageRef.replace("/lease.txt", "/LEASE.txt"), filename: "LEASE.txt", mimeType: "text/plain" });
        });
      } catch (error) { injectionError = error; }
      await purge();
    });
    expect(outcome).toBe("purged");
    const databaseError = (injectionError as { cause?: { code?: string; constraint?: string } })?.cause;
    expect([databaseError?.code, databaseError?.constraint]).toEqual(["23514", "documents_storage_ref_tombstone_guard"]);
    expect(purge).toHaveBeenCalledOnce();
    expect(await h.t.db.select().from(schema.documents)).toHaveLength(0);
    expect((await h.t.db.select().from(schema.storageCleanupOutbox))[0].purgedAt).not.toBeNull();
  });

  it("maps a tombstone inserted after the repository check to NOT_FOUND", async () => {
    await h.t.client.exec(`
      CREATE FUNCTION queue_ref_before_document_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO storage_cleanup_outbox (storage_ref) VALUES (NEW.storage_ref);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER queue_ref_before_document_insert_trigger BEFORE INSERT ON documents
        FOR EACH ROW EXECUTE FUNCTION queue_ref_before_document_insert();
    `);
    const ref = buildRef(userA, "racing.txt");
    await expect(createPendingDocument(h.t.db, userA, { storageRef: ref, filename: "racing.txt", mimeType: "text/plain" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await h.t.db.select().from(schema.documents)).toHaveLength(0);
    expect(await h.t.db.select().from(schema.storageCleanupOutbox)).toHaveLength(0);
  });

  it("uses a bounded batch", async () => {
    const rows = await Promise.all([insertDocument(h.t, userA, null), insertDocument(h.t, userA, null)]);
    await h.t.db.insert(schema.storageCleanupOutbox).values(rows.map((row) => ({ storageRef: row.storageRef })));
    await h.t.db.delete(schema.documents);
    const purge = vi.fn(async () => undefined);
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge), 1)).toEqual({ selected: 1, purged: 1, live: 0, failed: 0 });
    expect(purge).toHaveBeenCalledOnce();
    expect((await h.t.db.select().from(schema.storageCleanupOutbox)).filter((entry) => entry.purgedAt === null)).toHaveLength(1);
    await expect(runStorageCleanupBatch(h.t.db, fakePurger(purge), 51)).rejects.toThrow(RangeError);
  });

  it("does not let a live oldest ref starve a later eligible ref", async () => {
    const live = await insertDocument(h.t, userA, null);
    const eligible = buildRef(userA, "later.txt");
    await h.t.db.insert(schema.storageCleanupOutbox).values([
      { storageRef: live.storageRef, createdAt: new Date("2020-01-01T00:00:00Z") },
      { storageRef: eligible, createdAt: new Date("2021-01-01T00:00:00Z") },
    ]);
    const purge = vi.fn(async () => undefined);
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge), 1)).toEqual({ selected: 1, purged: 1, live: 0, failed: 0 });
    expect(purge).toHaveBeenCalledWith([eligible]);
    expect((await h.t.db.select().from(schema.storageCleanupOutbox)).filter((entry) => entry.purgedAt === null).map((entry) => entry.storageRef)).toEqual([live.storageRef]);
  });

  it("schedules a poison oldest ref so a newer good ref progresses at limit one", async () => {
    const poison = buildRef(userA, "poison.txt");
    const good = buildRef(userA, "good.txt");
    await h.t.db.insert(schema.storageCleanupOutbox).values([
      { storageRef: poison, createdAt: new Date("2020-01-01T00:00:00Z"), nextAttemptAt: new Date("2020-01-01T00:00:00Z") },
      { storageRef: good, createdAt: new Date("2021-01-01T00:00:00Z"), nextAttemptAt: new Date("2021-01-01T00:00:00Z") },
    ]);
    const purge = vi.fn(async (refs: string[]) => { if (refs[0] === poison) throw new Error("poison"); });
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge), 1)).toEqual({ selected: 1, purged: 0, live: 0, failed: 1 });
    expect(await runStorageCleanupBatch(h.t.db, fakePurger(purge), 1)).toEqual({ selected: 1, purged: 1, live: 0, failed: 0 });
    expect(purge.mock.calls.map(([refs]) => refs[0])).toEqual([poison, good]);
  });

  it("serializes duplicate cleanup attempts for one queued ref", async () => {
    const row = await insertDocument(h.t, userA, null);
    vi.spyOn(h.storage, "delete").mockRejectedValueOnce(new Error("object unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await removeDocument(row.id)).status).toBe(204);
    await h.t.db.update(schema.storageCleanupOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    const purge = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const results = await Promise.all([
      runStorageCleanupBatch(h.t.db, fakePurger(purge)),
      runStorageCleanupBatch(h.t.db, fakePurger(purge)),
    ]);
    expect(results.map((result) => result.purged).sort()).toEqual([0, 1]);
    expect(purge).toHaveBeenCalledOnce();
    expect((await h.t.db.select().from(schema.storageCleanupOutbox))[0].purgedAt).not.toBeNull();
  });
});
