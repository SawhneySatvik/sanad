import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { analyzedDocumentIds, documentTitles, listDraftChainsPage } from "@/server/data/library";
import { createClaimTestDb, insertDocument, insertDraftChain, otherUser, user } from "@tests/support/auth/claim";
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

it("listDraftChainsPage drops a chain the instant its grounding document or its project turns foreign, leaving the rest of the page alone", async () => {
  const ownedDocument = await insertDocument(t, user, null);
  const [ownedProject] = await t.db.insert(schema.projects).values({ ownerUserId: user.userId, name: "Owned" }).returning();
  const foreignDocument = await insertDocument(t, otherUser, null);
  const [foreignProject] = await t.db.insert(schema.projects).values({ ownerUserId: otherUser.userId, name: "Foreign" }).returning();

  const good = await insertDraftChain(t, user, null, ownedDocument.id, 1);
  const willGroundOnForeign = await insertDraftChain(t, user, null, ownedDocument.id, 1);
  const willJoinForeignProject = await insertDraftChain(t, user, null, ownedDocument.id, 1);
  for (const chain of [good, willGroundOnForeign, willJoinForeignProject]) {
    await t.db.update(schema.drafts).set({ projectId: ownedProject.id }).where(eq(schema.drafts.id, chain[0].id));
  }

  const before = (await listDraftChainsPage(t.db, user, null, 10)).map((entry) => entry.row.id);
  expect(before).toEqual(expect.arrayContaining([good[0].id, willGroundOnForeign[0].id, willJoinForeignProject[0].id]));

  await t.db.update(schema.drafts).set({ groundingDocumentId: foreignDocument.id }).where(eq(schema.drafts.id, willGroundOnForeign[0].id));
  await t.db.update(schema.drafts).set({ projectId: foreignProject.id }).where(eq(schema.drafts.id, willJoinForeignProject[0].id));

  const after = (await listDraftChainsPage(t.db, user, null, 10)).map((entry) => entry.row.id);
  expect(after).toContain(good[0].id);
  expect(after).not.toContain(willGroundOnForeign[0].id);
  expect(after).not.toContain(willJoinForeignProject[0].id);
});
