import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { claimGuestData } from "@/server/auth/claim";
import { analyze, analyzeDocument } from "@/server/services/understand";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, guestA, leaseOutput, MIME, userA, type Harness } from "@tests/support/services/understand";

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.close(); });

it("claim during a held analysis model call yields 404 and no analysis persistence", async () => {
  const failing = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "down") }] });
  await expect(analyze(h.deps(failing), guestA, await h.upload(guestA, "leave_and_license.txt", MIME.txt)))
    .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  const [document] = await h.t.db.select().from(schema.documents);
  const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
  let started!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const complete = llm.complete.bind(llm);
  vi.spyOn(llm, "complete").mockImplementation(async (input) => { started(); await held; return complete(input); });
  const pending = analyzeDocument(h.deps(llm), guestA, document.id);
  await waiting;
  await claimGuestData(h.t.db, guestA as Extract<typeof guestA, { type: "guest" }>, userA as Extract<typeof userA, { type: "user" }>);
  resume();
  await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await h.t.db.select().from(schema.analyses).where(eq(schema.analyses.documentId, document.id))).toHaveLength(0);
  expect(await h.t.db.select().from(schema.findings)).toHaveLength(0);
  expect(await h.t.db.select().from(schema.findingLensExplanations)).toHaveLength(0);
  expect(await h.t.db.select().from(schema.analyzedResultCache)).toHaveLength(0);
});

it("analysis persistence takes and rechecks a no-key-update document lock before its first write", () => {
  const service = readFileSync(path.join(process.cwd(), "src/server/services/understand.ts"), "utf8");
  const repository = readFileSync(path.join(process.cwd(), "src/server/data/analyses.ts"), "utf8");
  const transaction = service.slice(service.indexOf("await deps.db.transaction(async (tx) => {"));
  expect(transaction).toContain("await lockDocumentForAnalysisPersistence(tx, principal, documentId)");
  expect(transaction.indexOf("await lockDocumentForAnalysisPersistence(tx, principal, documentId)"))
    .toBeLessThan(transaction.indexOf("await insertAnalysisIfAbsent(tx, principal"));
  const lock = repository.slice(repository.indexOf("export async function lockDocumentForAnalysisPersistence"), repository.indexOf("export async function insertAnalysisIfAbsent"));
  // SHARE deadlocks two concurrent persisters: each waits on the other's lock for its updated_at bump.
  expect(lock).toContain('.for("no key update")');
  expect(lock).not.toContain('.for("share")');
  expect(lock.indexOf("assertCanAccess(principal, locked)")).toBeLessThan(lock.indexOf("await getDocumentSummary(tx, principal, documentId)"));
});
