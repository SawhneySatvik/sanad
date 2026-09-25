import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { claimGuestData } from "@/server/auth/claim";
import { markDocumentExtractionFailed, markDocumentReady } from "@/server/data/documents";
import { deleteAllLibraryRows, deleteLibraryRow, renameLibraryRow, unassignLibraryRow } from "@/server/data/library";
import { insertComparison, insertDocument, insertDraftChain } from "@tests/support/auth/claim";
import { createRouteHarness, userA, type RouteHarness } from "@tests/integration/routes/harness";

let h: RouteHarness;
beforeEach(async () => { h = await createRouteHarness(); });
afterEach(async () => { await h.close(); });

it("claim first makes every stale guest mutation fail closed, including delete-all and analysis completion", async () => {
  const guest = { type: "guest" as const, guestSessionId: "race-guest" };
  const a = await insertDocument(h.t, guest, new Date(Date.now() + 3600_000));
  const b = await insertDocument(h.t, guest, new Date(Date.now() + 3600_000));
  const comparison = await insertComparison(h.t, guest, a.id, b.id, new Date(Date.now() + 3600_000));
  const draft = (await insertDraftChain(h.t, guest, new Date(Date.now() + 3600_000), null, 2))[0];
  const [pending] = await h.t.db.insert(schema.documents).values({ ownerGuestSessionId: guest.guestSessionId,
    storageRef: `guest:${guest.guestSessionId}/pending.txt`, filename: "pending.txt", mimeType: "text/plain",
    expiresAt: new Date(Date.now() + 3600_000) }).returning();

  expect(await claimGuestData(h.t.db, guest, userA)).toEqual({ documents: 3, comparisons: 1, drafts: 2 });
  for (const [kind, id] of [["document", a.id], ["comparison", comparison.id], ["draft", draft.id]] as const) {
    await expect(renameLibraryRow(h.t.db, guest, kind, id, "stale rename")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(unassignLibraryRow(h.t.db, guest, kind, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteLibraryRow(h.t.db, guest, kind, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  expect(await deleteAllLibraryRows(h.t.db, guest)).toMatchObject({ deleted: {
    documents: 0, comparisons: 0, drafts: 0, threads: 0, projects: 0,
  } });
  await expect(markDocumentReady(h.t.db, guest, pending.id, { inputMode: "text", canonicalText: "text",
    canonicalTextHash: "hash", extractorVersion: "x", documentType: "generic",
    detectionConfidence: "1", jurisdiction: "IN" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(markDocumentExtractionFailed(h.t.db, guest, pending.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const [stored] = await h.t.db.select().from(schema.documents).where(eq(schema.documents.id, pending.id));
  expect(stored.ownerUserId).toBe(userA.userId);
  expect(stored.processingStatus).toBe("pending");
  expect(await h.t.db.select().from(schema.comparisons)).toHaveLength(1);
  expect(await h.t.db.select().from(schema.drafts)).toHaveLength(2);
});

it("guest delete-all first leaves no rows for a later claim to re-own", async () => {
  const guest = { type: "guest" as const, guestSessionId: "delete-first-guest" };
  const expiry = new Date(Date.now() + 3600_000);
  const a = await insertDocument(h.t, guest, expiry);
  const b = await insertDocument(h.t, guest, expiry);
  await insertComparison(h.t, guest, a.id, b.id, expiry);
  await insertDraftChain(h.t, guest, expiry, null, 2);
  expect((await deleteAllLibraryRows(h.t.db, guest)).deleted).toEqual({
    documents: 2, comparisons: 1, drafts: 2, threads: 0, projects: 0,
  });
  expect(await claimGuestData(h.t.db, guest, userA)).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
  expect(await h.t.db.select().from(schema.documents)).toHaveLength(0);
  expect(await h.t.db.select().from(schema.drafts)).toHaveLength(0);
});
