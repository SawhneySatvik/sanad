// openSample()/openSampleEntry() gates that need a real db + real storage: a stale/tampered entry
// refuses before anything is created or written; a lost-race reservation cleans up the object it
// wrote; re-opening an existing copy never rate-limits, even at the row cap.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { canAccess } from "@/server/data/access";
import { openSample, openSampleEntry, type OpenSampleDeps } from "@/server/samples/open";
import { allSampleEntries } from "@/server/samples/registry";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";

const principal: Principal = { type: "guest", guestSessionId: "open-test-guest" };

let t: TestDb;
let rootDir: string;
afterEach(async () => {
  await t.close();
  await rm(rootDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function harness(): Promise<OpenSampleDeps> {
  t = await createTestDb();
  rootDir = await mkdtemp(path.join(tmpdir(), "open-test-"));
  const storage = new LocalFsStorageAdapter({
    rootDir,
    signingSecret: "open-test-signing-secret-0123456789abcdef",
    accessCheck: canAccess,
  });
  return { db: t.db, storage };
}

function entryFor(sampleId: string) {
  const entry = allSampleEntries().find((e) => e.sampleId === sampleId);
  if (!entry) throw new Error(`${sampleId} entry missing from the registry`);
  return entry;
}

async function documentCount(): Promise<number> {
  const result = await t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM documents");
  return result.rows[0].n;
}

async function countFilesRecursively(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    count += entry.isDirectory() ? await countFilesRecursively(full) : 1;
  }
  return count;
}

describe("a stale/tampered entry refuses before any row is created or any byte written", () => {
  it("NOT_FOUND, zero document rows, zero files under the storage root", async () => {
    const deps = await harness();
    const tampered = { ...entryFor("offer_letter"), inputFingerprint: "0".repeat(64) };

    await expect(openSampleEntry(deps, principal, tampered)).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await documentCount()).toBe(0);
    expect(await countFilesRecursively(rootDir)).toBe(0);
  });
});

describe("a lost-race reservation cleans up the object it wrote", () => {
  it("opening the same sample twice for one guest leaves exactly one file under the storage root", async () => {
    const deps = await harness();
    const first = await openSample(deps, principal, "lease");
    const second = await openSample(deps, principal, "lease");

    expect(second.documentId).toBe(first.documentId);
    expect(await documentCount()).toBe(1);
    // The second call also wrote a fresh copy of the bytes under its own ref before discovering the
    // first call's row already exists — this is what must be cleaned up, not merely never written.
    expect(await countFilesRecursively(rootDir)).toBe(1);
  });
});

describe("re-opening an existing copy never rate-limits, even at the row cap", () => {
  it("a second open of the SAME sample at cap 1 returns the existing copy, not 429", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "1");
    const deps = await harness();
    const first = await openSample(deps, principal, "lease");
    const second = await openSample(deps, principal, "lease");
    expect(second.documentId).toBe(first.documentId);
  });

  it("positive control: a DIFFERENT sample at cap 1 still 429s — the cap is real", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "1");
    const deps = await harness();
    await openSample(deps, principal, "lease");
    await expect(openSample(deps, principal, "nda")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("a reservation failure (not merely a lost race) cleans up the object it wrote", () => {
  it("a RATE_LIMITED reservation leaves only the successful sample's file behind, never the rejected one's", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "1");
    const deps = await harness();
    await openSample(deps, principal, "lease");
    await expect(openSample(deps, principal, "nda")).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // Exactly one file: lease's own. The rejected nda reservation must not leave its freshly written
    // bytes behind — the catch block's cleanup, not merely the lost-race branch, is what removes it.
    expect(await countFilesRecursively(rootDir)).toBe(1);
  });
});
