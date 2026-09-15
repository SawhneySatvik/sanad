// Shared harness for the Understand service tests: real PGlite (createTestDb), real
// LocalFsStorageAdapter over a temp directory with the real canAccess, and FakeLlmClient at the
// provider boundary — nothing else is faked (CLAUDE.md mocking policy).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { canAccess } from "@/server/data/access";
import type { DocumentTypeId } from "@/server/deterministic/document-type-registry";
import type { LlmClient } from "@/server/llm/types";
import { LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import type { NewDocumentInput } from "@/server/data/documents";
import type { UnderstandDeps, UnderstandFinding, UnderstandResult } from "@/server/services/understand";

/** Narrows an `UnderstandResult` to its `complete` variant's findings, or throws. */
export function findingsOf(result: UnderstandResult): UnderstandFinding[] {
  if (result.analysisState !== "complete") throw new Error(`expected a completed analysis, got ${result.analysisState}`);
  return result.findings;
}

/** Where the curated document fixtures (`upload()`'s `fixture` argument) live on disk. */
export const FIXTURES_DIR = path.join(process.cwd(), "tests", "fixtures", "documents");
/** The `modelId` every harness's `deps()` reports as primary. */
export const TEST_MODEL_ID = "fake-model";

// Two users and two guests, used across the Understand tests as "self" vs "the foreign principal"
// in IDOR pairs.
export const USER_A_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
export const USER_B_ID = "0b0b0b0b-0000-4000-8000-00000000000b";
export const userA: Principal = { type: "user", userId: USER_A_ID };
export const userB: Principal = { type: "user", userId: USER_B_ID };
export const guestA: Principal = { type: "guest", guestSessionId: "guest-session-a" };
export const guestB: Principal = { type: "guest", guestSessionId: "guest-session-b" };

/** MIME types accepted by `upload()`/`uploadBytes()`. */
export const MIME = {
  txt: "text/plain",
  pdf: "application/pdf",
} as const;

// Cut verbatim from tests/fixtures/documents/leave_and_license.txt.
export const LEASE = {
  licenseFee: "The Licensee shall pay to the Licensor a monthly license fee (monthly rent) of Rs. 32,000/-",
  depositRefund: "The security deposit shall be refunded within 15 days of vacating the premises",
  // Crosses a line break in the fixture; the quote has a space where the text has "\n".
  deductions: "subject to deduction of any dues or damages",
  lockIn: "There shall be a lock-in period of three (3) months from the commencement date",
  notice: "Either Party may terminate this Agreement by giving one (1) month's prior written notice",
  wearAndTear: "normal wear and tear excepted",
  // Not in the document.
  fabricated: "A late fee of Rs. 500 per day shall be charged for any delay in payment of the license fee",
  // The fixture says "for structural repairs", not "for all structural repairs".
  nearMiss: "The Licensor shall be responsible for all structural repairs to the Licensed Premises",
} as const;

/** One scripted lens explanation per lens registered for `documentType`, all mentioning `subject`. */
export function lensExplanationsFor(documentType: DocumentTypeId, subject: string): Record<string, string> {
  return Object.fromEntries(
    LENSES_BY_DOCUMENT_TYPE[documentType].map((lens) => [lens.id, `${subject} — as seen by ${lens.id}.`]),
  );
}

/** A single scripted finding shaped for a leave_and_license model response. */
export function leaseFinding(category: string, quote: string | null, subject: string) {
  return { category, quote, lensExplanations: lensExplanationsFor("leave_and_license", subject) };
}

// A realistic model answer for the lease fixture: grounded quotes, one fabricated, one near-miss,
// one missing clause.
export function leaseOutput() {
  return {
    findings: [
      leaseFinding("obligation", LEASE.licenseFee, "Monthly fee of Rs. 32,000"),
      leaseFinding("deadline", LEASE.depositRefund, "Deposit refund within 15 days"),
      leaseFinding("penalty", LEASE.deductions, "Deductions from the deposit"),
      leaseFinding("deadline", LEASE.lockIn, "Three-month lock-in"),
      leaseFinding("obligation", LEASE.notice, "One month's notice"),
      leaseFinding("ambiguity", LEASE.wearAndTear, "Normal wear and tear is undefined"),
      leaseFinding("penalty", LEASE.fabricated, "Late fee"),
      leaseFinding("obligation", LEASE.nearMiss, "Structural repairs"),
      leaseFinding("missing_clause", null, "No clause on who pays stamp duty and registration"),
    ],
  };
}

/** How many findings `leaseOutput()` scripts, for tests that assert an exact count. */
export const LEASE_FINDING_COUNT = leaseOutput().findings.length;

/** The Understand service test harness: a real DB, real storage, row counters, and a `deps()` builder for a given LlmClient. */
export interface Harness {
  t: TestDb;
  storage: LocalFsStorageAdapter;
  deps(llm: LlmClient): UnderstandDeps;
  // Uploads a fixture through the real storage adapter; returns analyze()'s input for it, with the
  // filename and type it was declared as.
  upload(principal: Principal, fixture: string, mimeType: string): Promise<NewDocumentInput>;
  uploadBytes(principal: Principal, filename: string, mimeType: string, bytes: Uint8Array): Promise<NewDocumentInput>;
  counts(): Promise<{ documents: number; analyses: number; findings: number; lenses: number; cache: number }>;
  close(): Promise<void>;
}

/** Builds a fresh Understand service `Harness`: its own database and a temp-directory storage root. */
export async function createHarness(): Promise<Harness> {
  const t = await createTestDb();
  await t.db.insert(schema.users).values([
    { id: USER_A_ID, email: "a@example.com" },
    { id: USER_B_ID, email: "b@example.com" },
  ]);
  const rootDir = await mkdtemp(path.join(tmpdir(), "understand-test-"));
  const storage = new LocalFsStorageAdapter({
    rootDir,
    signingSecret: "understand-test-signing-secret-0123456789",
    accessCheck: canAccess,
  });

  async function uploadBytes(principal: Principal, filename: string, mimeType: string, bytes: Uint8Array) {
    const target = await storage.createUploadTarget(principal, { filename, mimeType, sizeBytes: bytes.byteLength });
    await storage.writeRelayed(principal, target.ref, bytes);
    return { storageRef: target.ref, filename, mimeType };
  }

  async function count(table: string): Promise<number> {
    const result = await t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0].n;
  }

  return {
    t,
    storage,
    // A no-op charge: these tests read the analysis cache without exercising rate limits.
    deps: (llm) => ({ db: t.db, storage, llm, modelId: TEST_MODEL_ID, chargeLlmCall: async () => {} }),
    uploadBytes,
    upload: async (principal, fixture, mimeType) =>
      uploadBytes(principal, fixture, mimeType, await readFile(path.join(FIXTURES_DIR, fixture))),
    counts: async () => ({
      documents: await count("documents"),
      analyses: await count("analyses"),
      findings: await count("findings"),
      lenses: await count("finding_lens_explanations"),
      cache: await count("analyzed_result_cache"),
    }),
    close: async () => {
      await t.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
