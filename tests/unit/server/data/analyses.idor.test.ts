// Cross-principal access to analyses and the result cache: both are authorized through the document
// they belong to.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { findLatestAnalysis, getCachedAnalysisOutput, insertAnalysisIfAbsent, putCachedAnalysisOutput } from "@/server/data/analyses";
import { caught, createRepoTestDb, guestA, guestB, readyDocument, userA } from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("analyses IDOR", () => {
  it("another principal cannot create an analysis on the document; the owner can", async () => {
    const document = await readyDocument(t, guestA);
    const input = { documentId: document.id, promptVersion: "p", modelUsed: "m" };
    expect((await caught(insertAnalysisIfAbsent(t.db, guestB, input))).code).toBe("NOT_FOUND");
    expect((await caught(insertAnalysisIfAbsent(t.db, userA, input))).code).toBe("NOT_FOUND");
    expect(await t.db.select().from(schema.analyses)).toHaveLength(0);
    expect(await insertAnalysisIfAbsent(t.db, guestA, input)).not.toBeNull();
  });

  it("another principal gets NOT_FOUND from findLatestAnalysis, not null", async () => {
    const document = await readyDocument(t, userA);
    await insertAnalysisIfAbsent(t.db, userA, { documentId: document.id, promptVersion: "p", modelUsed: "m" });
    expect((await caught(findLatestAnalysis(t.db, guestA, document.id))).code).toBe("NOT_FOUND");
    expect(await findLatestAnalysis(t.db, userA, document.id)).not.toBeNull();
  });

  it("another principal can neither read nor write the cache through someone else's document", async () => {
    const lookup = { promptVersion: "p1", modelId: "m1" };
    const entry = { promptVersion: "p1", modelUsed: "m1", rawModelOutput: '{"findings":[]}' };
    const document = await readyDocument(t, guestA);
    await putCachedAnalysisOutput(t.db, guestA, document.id, entry);
    expect((await caught(getCachedAnalysisOutput(t.db, guestB, document.id, lookup))).code).toBe("NOT_FOUND");
    expect((await caught(putCachedAnalysisOutput(t.db, userA, document.id, { ...entry, rawModelOutput: "x" }))).code).toBe(
      "NOT_FOUND",
    );
    expect((await getCachedAnalysisOutput(t.db, guestA, document.id, lookup))?.rawModelOutput).toBe(entry.rawModelOutput);
  });
});
