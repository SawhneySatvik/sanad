import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRef } from "@/server/storage/refs";
import { createPendingDocument } from "@/server/data/documents";
import { createDraft } from "@/server/data/drafts";
import { createComparison } from "@/server/data/comparisons";
import { getSession } from "@/server/services/session";
import { requiredSectionKeys } from "@/server/deterministic/draft-templates";
import { createRepoTestDb, guestA, readyDocument } from "@tests/support/data/documents";

afterEach(() => { vi.unstubAllEnvs(); });

describe("guest data and session expiry seam", () => {
  it("uses the e2e override for new documents, drafts, and the session notice", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_GUEST_TTL_SECONDS", "12");
    const t = await createRepoTestDb();
    try {
      const before = Date.now();
      const document = await createPendingDocument(t.db, guestA, { storageRef: buildRef(guestA, "lease.txt"), filename: "lease.txt", mimeType: "text/plain" });
      const draft = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", content: "text", modelUsed: "fake-model", jurisdiction: "IN",
        sections: requiredSectionKeys("nda").map((sectionKey) => ({ sectionKey, provenance: "templated" as const, content: "text" })) });
      const a = await readyDocument(t, guestA);
      const b = await readyDocument(t, guestA);
      const comparison = await createComparison(t.db, guestA, { documentAId: a.id, documentBId: b.id, modelUsed: "none", changes: [] });
      expect(document.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 12000);
      expect(document.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 12000);
      expect(draft.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 12000);
      expect(draft.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 12000);
      expect(comparison.comparison.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 12000);
      expect(comparison.comparison.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 12000);
      expect((await getSession({ db: t.db }, guestA)).guestTtlHours).toBe(12 / 3600);
    } finally { await t.close(); }
  });
});
