import { afterEach, beforeEach, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { analyzedDocumentIds, documentTitles } from "@/server/data/library";
import { createClaimTestDb, insertDocument, otherUser, user } from "@tests/support/auth/claim";
import type { TestDb } from "@tests/support/db";

let t: TestDb;
beforeEach(async () => { t = await createClaimTestDb(); });
afterEach(async () => { await t.close(); });

it("title and analysis lookups return only the caller's documents, even when handed a foreign id", async () => {
  const mine = await insertDocument(t, user, null);
  const theirs = await insertDocument(t, otherUser, null);
  await t.db.insert(schema.analyses).values([mine, theirs].map((row) => ({ documentId: row.id, promptVersion: "v1", modelUsed: "m" })));

  expect([...(await documentTitles(t.db, user, [mine.id, theirs.id])).keys()]).toEqual([mine.id]);
  expect([...await analyzedDocumentIds(t.db, user, [mine.id, theirs.id])]).toEqual([mine.id]);
  expect(await analyzedDocumentIds(t.db, { type: "guest", guestSessionId: "nobody" }, [mine.id, theirs.id])).toEqual(new Set());
});
