// Shared setup for the documents / analyses / findings / lens-explanations repository tests.

import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import { AppError } from "@/server/core/errors";
import type { InputMode, Principal } from "@/server/core/types";
import { extractDocument } from "@/server/deterministic/extract";
import { buildRef } from "@/server/storage/refs";
import { createPendingDocument, markDocumentReady, type Document } from "@/server/data/documents";

// Two users and two guests, used across the repository tests as "self" vs "the foreign principal"
// in IDOR pairs.
export const USER_A_ID = "1a1a1a1a-0000-4000-8000-00000000000a";
export const USER_B_ID = "1b1b1b1b-0000-4000-8000-00000000000b";
export const userA: Principal = { type: "user", userId: USER_A_ID };
export const userB: Principal = { type: "user", userId: USER_B_ID };
export const guestA: Principal = { type: "guest", guestSessionId: "repo-guest-a" };
export const guestB: Principal = { type: "guest", guestSessionId: "repo-guest-b" };

/** Canonical text for a ready document fixture, and a quote known to occur in it verbatim. */
export const SAMPLE_TEXT =
  "1. The Licensee shall pay a monthly license fee of Rs. 32,000 on or before the 5th day of every month.\n" +
  "2. Either Party may terminate this Agreement by giving one month's prior written notice.";
export const SAMPLE_QUOTE = "Either Party may terminate this Agreement by giving one month's prior written notice";

/** A TestDb with `userA`/`userB` rows already present, for repository tests to insert against. */
export async function createRepoTestDb(): Promise<TestDb> {
  const t = await createTestDb();
  await t.db.insert(schema.users).values([
    { id: USER_A_ID, email: "a@example.com" },
    { id: USER_B_ID, email: "b@example.com" },
  ]);
  return t;
}

/** The storage ref a document owned by `principal` would use, without inserting a row. */
export function refFor(principal: Principal, filename = "doc.txt"): string {
  return buildRef(principal, filename);
}

/** Inserts a document row in the `pending` (not-yet-extracted) state. */
export async function pendingDocument(t: TestDb, principal: Principal): Promise<Document> {
  return createPendingDocument(t.db, principal, { storageRef: refFor(principal), filename: "doc.txt", mimeType: "text/plain" });
}

/** Inserts a document and runs it through real extraction to `ready`, with canonical text/hash set. */
export async function readyDocument(
  t: TestDb,
  principal: Principal,
  text = SAMPLE_TEXT,
  inputMode: InputMode = "text",
): Promise<Document> {
  const pending = await pendingDocument(t, principal);
  const extracted = await extractDocument({ pastedText: text });
  if (extracted.kind !== "extracted") throw new Error("sample text did not extract");
  const ready = await markDocumentReady(t.db, principal, pending.id, {
    inputMode,
    canonicalText: extracted.canonicalText,
    canonicalTextHash: extracted.canonicalTextHash,
    extractorVersion: extracted.extractorVersion,
    documentType: "leave_and_license",
    detectionConfidence: "0.50",
    jurisdiction: "IN",
  });
  if (!ready) throw new Error("document was not pending");
  return ready;
}

/** Awaits `promise`, asserts it rejects with an AppError, and returns that error for assertions. */
export async function caught(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}
