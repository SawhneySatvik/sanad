// Cross-principal cases live in analyses.idor.test.ts (collected by `npm test -- idor`).

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import {
  ANALYSIS_CACHE_TTL_SECONDS,
  analysisCacheKey,
  findLatestAnalysis,
  getCachedAnalysisOutput,
  insertAnalysisIfAbsent,
  putCachedAnalysisOutput,
} from "@/server/data/analyses";
import { caught, createRepoTestDb, guestA, guestB, pendingDocument, readyDocument, userA } from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("insertAnalysisIfAbsent — idempotency guard", () => {
  it("inserts once per (document, prompt_version, model_used); a repeat returns null and adds nothing", async () => {
    const document = await readyDocument(t, guestA);
    const input = { documentId: document.id, promptVersion: "p1", modelUsed: "m1" };

    const first = await insertAnalysisIfAbsent(t.db, guestA, input);
    expect(first).toMatchObject(input);
    expect(await insertAnalysisIfAbsent(t.db, guestA, input)).toBeNull();
    expect(await t.db.select().from(schema.analyses)).toHaveLength(1);

    const otherModel = await insertAnalysisIfAbsent(t.db, guestA, { ...input, modelUsed: "m2" });
    expect(otherModel?.id).not.toBe(first!.id);
    expect(await t.db.select().from(schema.analyses)).toHaveLength(2);
  });

});

describe("findLatestAnalysis", () => {
  it("returns the newest run, optionally for one prompt version; null when none", async () => {
    const document = await readyDocument(t, guestA);
    expect(await findLatestAnalysis(t.db, guestA, document.id)).toBeNull();

    const older = await insertAnalysisIfAbsent(t.db, guestA, { documentId: document.id, promptVersion: "p1", modelUsed: "m" });
    await t.db.update(schema.analyses).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(schema.analyses.id, older!.id));
    const newer = await insertAnalysisIfAbsent(t.db, guestA, { documentId: document.id, promptVersion: "p2", modelUsed: "m" });

    expect((await findLatestAnalysis(t.db, guestA, document.id))?.id).toBe(newer!.id);
    expect((await findLatestAnalysis(t.db, guestA, document.id, "p1"))?.id).toBe(older!.id);
    expect(await findLatestAnalysis(t.db, guestA, document.id, "p3")).toBeNull();
  });
});

describe("analysisCacheKey", () => {
  const parts = { canonicalTextHash: "h", documentType: "nda", jurisdiction: "IN", promptVersion: "p", modelId: "m" };

  it("is stable and changes with every one of its five components", () => {
    const key = analysisCacheKey(parts);
    expect(analysisCacheKey({ ...parts })).toBe(key);
    const variants = [
      { ...parts, canonicalTextHash: "h2" },
      { ...parts, documentType: "generic" },
      { ...parts, jurisdiction: "US" },
      { ...parts, promptVersion: "p2" },
      { ...parts, modelId: "m2" },
    ].map(analysisCacheKey);
    expect(new Set([key, ...variants]).size).toBe(6);
  });

  it("components cannot bleed into each other", () => {
    expect(analysisCacheKey({ ...parts, canonicalTextHash: "ab", documentType: "c" })).not.toBe(
      analysisCacheKey({ ...parts, canonicalTextHash: "a", documentType: "bc" }),
    );
  });
});

describe("result cache", () => {
  const lookup = { promptVersion: "p1", modelId: "m1" };
  const entry = { promptVersion: "p1", modelUsed: "m1", rawModelOutput: '{"findings":[]}' };

  it("round-trips raw output for the same content, and a different model id misses", async () => {
    const document = await readyDocument(t, userA);
    expect(await getCachedAnalysisOutput(t.db, userA, document.id, lookup)).toBeNull();
    await putCachedAnalysisOutput(t.db, userA, document.id, entry);

    expect(await getCachedAnalysisOutput(t.db, userA, document.id, lookup)).toEqual({
      rawModelOutput: entry.rawModelOutput,
      modelUsed: "m1",
    });
    expect(await getCachedAnalysisOutput(t.db, userA, document.id, { ...lookup, modelId: "m2" })).toBeNull();

    // Keyed by content: another principal's document with the same text shares the entry.
    const same = await readyDocument(t, guestB);
    expect(await getCachedAnalysisOutput(t.db, guestB, same.id, lookup)).not.toBeNull();
  });

  it("a guest document caps the entry's expiry at the document's own; a user document gets the cache TTL", async () => {
    const guestDocument = await readyDocument(t, guestA);
    await putCachedAnalysisOutput(t.db, guestA, guestDocument.id, entry);
    const [guestRow] = await t.db.select().from(schema.analyzedResultCache);
    expect(guestRow.expiresAt.getTime()).toBe(guestDocument.expiresAt!.getTime());

    await t.db.delete(schema.analyzedResultCache);
    const userDocument = await readyDocument(t, userA);
    await putCachedAnalysisOutput(t.db, userA, userDocument.id, entry);
    const [userRow] = await t.db.select().from(schema.analyzedResultCache);
    expect(Math.abs(userRow.expiresAt.getTime() - (Date.now() + ANALYSIS_CACHE_TTL_SECONDS * 1000))).toBeLessThan(60_000);
  });

  it("an expired entry is not served, and a later put replaces it", async () => {
    const document = await readyDocument(t, userA);
    await putCachedAnalysisOutput(t.db, userA, document.id, entry);
    await t.db.update(schema.analyzedResultCache).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getCachedAnalysisOutput(t.db, userA, document.id, lookup)).toBeNull();

    await putCachedAnalysisOutput(t.db, userA, document.id, { ...entry, rawModelOutput: '{"findings":[1]}' });
    expect((await getCachedAnalysisOutput(t.db, userA, document.id, lookup))?.rawModelOutput).toBe('{"findings":[1]}');
    expect(await t.db.select().from(schema.analyzedResultCache)).toHaveLength(1);
  });

  it("a document that has not been extracted has no cache key", async () => {
    const pending = await pendingDocument(t, guestA);
    const error = await caught(getCachedAnalysisOutput(t.db, guestA, pending.id, lookup));
    expect(error.code).toBe("INVALID_DOCUMENT");
    expect(error.reason).toBe("document_not_ready");
  });
});
