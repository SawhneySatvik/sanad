// Cross-principal access to the documents repository.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import {
  createPendingDocument,
  getDocument,
  getDocumentSummary,
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

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";
const extraction = {
  inputMode: "text" as const,
  canonicalText: "text",
  canonicalTextHash: "hash",
  extractorVersion: "1",
  documentType: "generic" as const,
  detectionConfidence: "0.00",
  jurisdiction: "IN",
};

describe("documents IDOR", () => {
  it("a storage ref minted for another principal is NOT_FOUND and creates no row", async () => {
    const error = await caught(
      createPendingDocument(t.db, guestB, { storageRef: refFor(guestA), filename: "x.txt", mimeType: "text/plain" }),
    );
    expect(error.code).toBe("NOT_FOUND");
    const malformed = await caught(
      createPendingDocument(t.db, guestB, { storageRef: "../../etc/passwd", filename: "x", mimeType: "text/plain" }),
    );
    expect(malformed.code).toBe("NOT_FOUND");
    expect(await t.db.select().from(schema.documents)).toHaveLength(0);
  });

  it("foreign, missing and malformed ids are the same NOT_FOUND for both reads; the owner reads it", async () => {
    const document = await readyDocument(t, userA);
    for (const read of [getDocument, getDocumentSummary]) {
      const foreign = await caught(read(t.db, userB, document.id));
      const guest = await caught(read(t.db, guestA, document.id));
      const missing = await caught(read(t.db, userB, MISSING_ID));
      const malformed = await caught(read(t.db, userB, "1 OR 1=1"));
      expect(foreign.code).toBe("NOT_FOUND");
      for (const other of [guest, missing, malformed]) {
        expect([other.code, other.message]).toEqual([foreign.code, foreign.message]);
      }
      expect((await read(t.db, userA, document.id)).id).toBe(document.id);
    }
  });

  it("another principal cannot mark a document ready or failed", async () => {
    const pending = await pendingDocument(t, guestA);
    expect((await caught(markDocumentReady(t.db, guestB, pending.id, extraction))).code).toBe("NOT_FOUND");
    expect((await caught(markDocumentExtractionFailed(t.db, userA, pending.id))).code).toBe("NOT_FOUND");
    const [row] = await t.db.select().from(schema.documents).where(eq(schema.documents.id, pending.id));
    expect(row.processingStatus).toBe("pending");
  });
});
