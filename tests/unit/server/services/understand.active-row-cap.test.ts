import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { analyze } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, FIXTURES_DIR, guestA, type Harness, leaseOutput, MIME } from "@tests/support/services/understand";

// analyze() checks the active-document cap before the one-shot confirmUpload: a rejection after it
// would spend the upload's ref and leave a confirmed object no document points at.

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h.close();
});

describe("analyze — the active-document cap", () => {
  it("at the cap: RATE_LIMITED with no model call and the ref unspent; once a document expires, the same ref analyzes", async () => {
    vi.stubEnv("MAX_ACTIVE_ROWS_PER_GUEST", "1");
    const bytes = await readFile(path.join(FIXTURES_DIR, "leave_and_license.txt"));
    const llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
    const first = await analyze(h.deps(llm), guestA, await h.uploadBytes(guestA, "one.txt", MIME.txt, bytes));
    const second = await h.uploadBytes(guestA, "two.txt", MIME.txt, Buffer.concat([bytes, Buffer.from("\nSecond copy.\n")]));

    await expect(analyze(h.deps(llm), guestA, second)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(llm.callCount).toBe(1);
    expect((await h.counts()).documents).toBe(1);

    await h.t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.documents.id, first.document.id));
    const analyzed = await analyze(h.deps(llm), guestA, second);

    expect(analyzed.analysisState).toBe("complete");
    expect(llm.callCount).toBe(2);
  });
});
