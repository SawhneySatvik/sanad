// Cross-principal access to findings: authorized through the
// finding's document.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { verify } from "@/server/deterministic/verify";
import { insertAnalysisIfAbsent } from "@/server/data/analyses";
import { insertFindings, listFindings } from "@/server/data/findings";
import { caught, createRepoTestDb, guestA, guestB, readyDocument, SAMPLE_QUOTE, userA } from "@tests/support/data/documents";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("findings IDOR", () => {
  it("another principal can neither write findings to nor list findings of the document; the owner can", async () => {
    const document = await readyDocument(t, guestA);
    const analysis = await insertAnalysisIfAbsent(t.db, guestA, { documentId: document.id, promptVersion: "p", modelUsed: "m" });
    const analysisId = analysis!.id;
    const finding = {
      category: "obligation" as const,
      quote: SAMPLE_QUOTE,
      explanation: "e",
      verification: verify({ quote: SAMPLE_QUOTE, canonicalText: document.canonicalText!, inputMode: "text" }),
    };

    for (const intruder of [guestB, userA]) {
      const writeError = await caught(
        insertFindings(t.db, intruder, { documentId: document.id, analysisId, modelUsed: "m", findings: [finding] }),
      );
      expect(writeError.code).toBe("NOT_FOUND");
      expect((await caught(listFindings(t.db, intruder, document.id, analysisId))).code).toBe("NOT_FOUND");
    }
    expect(await t.db.select().from(schema.findings)).toHaveLength(0);

    await insertFindings(t.db, guestA, { documentId: document.id, analysisId, modelUsed: "m", findings: [finding] });
    expect(await listFindings(t.db, guestA, document.id, analysisId)).toHaveLength(1);
  });
});
