// Cross-principal cases live in documents.idor.test.ts (collected by `npm test -- idor`).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import {
  createPendingDocument,
  DOCUMENT_GUEST_TTL_SECONDS,
  getDocument,
  getDocumentSummary,
  listDocuments,
  markDocumentExtractionFailed,
  markDocumentReady,
} from "@/server/data/documents";
import {
  caught,
  createRepoTestDb,
  guestA,
  guestB,
  pendingDocument,
  readyDocument,
  refFor,
  USER_A_ID,
  userA,
  userB,
} from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

const extraction = {
  inputMode: "text" as const,
  canonicalText: "text",
  canonicalTextHash: "hash",
  extractorVersion: "1",
  documentType: "generic" as const,
  detectionConfidence: "0.00",
  jurisdiction: "IN",
};

describe("createPendingDocument", () => {
  it("a guest document is guest-owned, pending, and expires after the guest TTL", async () => {
    const before = Date.now();
    const document = await pendingDocument(t, guestA);
    expect(document).toMatchObject({ ownerGuestSessionId: "repo-guest-a", ownerUserId: null, processingStatus: "pending" });
    expect(document.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + DOCUMENT_GUEST_TTL_SECONDS * 1000);
    expect(document.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + DOCUMENT_GUEST_TTL_SECONDS * 1000);
    expect(DOCUMENT_GUEST_TTL_SECONDS).toBe(3 * 60 * 60);
  });

  it("a user document is user-owned and never expires", async () => {
    const document = await pendingDocument(t, userA);
    expect(document).toMatchObject({ ownerUserId: USER_A_ID, ownerGuestSessionId: null, expiresAt: null });
  });

  it("a ref that already backs a document is NOT_FOUND — one row per stored object", async () => {
    const storageRef = refFor(guestA);
    await createPendingDocument(t.db, guestA, { storageRef, filename: "x.txt", mimeType: "text/plain" });
    const error = await caught(createPendingDocument(t.db, guestA, { storageRef, filename: "x.txt", mimeType: "text/plain" }));
    expect(error.code).toBe("NOT_FOUND");
    expect(await t.db.select().from(schema.documents)).toHaveLength(1);
  });
});

describe("getDocument / getDocumentSummary", () => {
  it("the owner reads its document; the summary omits canonical_text", async () => {
    const document = await readyDocument(t, guestA);
    expect((await getDocument(t.db, guestA, document.id)).canonicalText).toBe(document.canonicalText);
    const summary = await getDocumentSummary(t.db, guestA, document.id);
    expect(summary.id).toBe(document.id);
    expect("canonicalText" in summary).toBe(false);
  });
});

describe("listDocuments", () => {
  it("returns only the principal's own documents, newest first, without canonical_text", async () => {
    const first = await readyDocument(t, guestA);
    const second = await pendingDocument(t, guestA);
    await readyDocument(t, guestB);
    await readyDocument(t, userA);

    const listed = await listDocuments(t.db, guestA);
    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(listed.every((row) => !("canonicalText" in row))).toBe(true);
    expect((await listDocuments(t.db, userA)).map((row) => row.ownerUserId)).toEqual([USER_A_ID]);
    expect(await listDocuments(t.db, userB)).toEqual([]);
  });
});

describe("markDocumentReady / markDocumentExtractionFailed", () => {
  it("a pending document becomes ready once; a second extraction returns null and changes nothing", async () => {
    const pending = await pendingDocument(t, guestA);
    const ready = await markDocumentReady(t.db, guestA, pending.id, extraction);
    expect(ready).toMatchObject({ processingStatus: "ready", canonicalText: "text", documentType: "generic", jurisdiction: "IN" });

    expect(await markDocumentReady(t.db, guestA, pending.id, { ...extraction, canonicalText: "changed" })).toBeNull();
    expect((await getDocument(t.db, guestA, pending.id)).canonicalText).toBe("text");
  });

  it("extraction failure marks a pending document, and never demotes a ready one", async () => {
    const pending = await pendingDocument(t, guestA);
    await markDocumentExtractionFailed(t.db, guestA, pending.id);
    expect((await getDocument(t.db, guestA, pending.id)).processingStatus).toBe("extraction_failed");

    const ready = await readyDocument(t, guestA);
    await markDocumentExtractionFailed(t.db, guestA, ready.id);
    expect((await getDocument(t.db, guestA, ready.id)).processingStatus).toBe("ready");
  });
});
