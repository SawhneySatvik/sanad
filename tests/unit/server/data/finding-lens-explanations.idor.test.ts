// Cross-principal and cross-document access to lens rows: an association checks ownership of every
// entity it names.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { insertLensExplanations, listLensExplanations } from "@/server/data/finding-lens-explanations";
import { caught, createRepoTestDb, guestA, guestB, userA } from "@tests/support/data/documents";
import { documentWithFindings, LENSES } from "@tests/support/data/finding-lens-explanations";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("finding lens explanations IDOR", () => {
  it("lens rows cannot be attached to a finding of another document — even the caller's own", async () => {
    const mine = await documentWithFindings(t, guestA, 1);
    const alsoMine = await documentWithFindings(t, guestA, 1);
    const error = await caught(
      insertLensExplanations(t.db, guestA, mine.document.id, [
        { findingId: alsoMine.findings[0].id, roleStageLens: LENSES[0], explanation: "x" },
      ]),
    );
    expect(error.code).toBe("NOT_FOUND");
    const malformed = await caught(
      insertLensExplanations(t.db, guestA, mine.document.id, [{ findingId: "nope", roleStageLens: LENSES[0], explanation: "x" }]),
    );
    expect(malformed.code).toBe("NOT_FOUND");
    expect(await t.db.select().from(schema.findingLensExplanations)).toHaveLength(0);
  });

  it("another principal can neither write nor read lens rows through the document; the owner can", async () => {
    const { document, analysisId, findings } = await documentWithFindings(t, guestA, 1);
    const row = { findingId: findings[0].id, roleStageLens: LENSES[0], explanation: "x" };
    for (const intruder of [guestB, userA]) {
      expect((await caught(insertLensExplanations(t.db, intruder, document.id, [row]))).code).toBe("NOT_FOUND");
      expect((await caught(listLensExplanations(t.db, intruder, document.id, analysisId))).code).toBe("NOT_FOUND");
    }
    expect(await t.db.select().from(schema.findingLensExplanations)).toHaveLength(0);
    await insertLensExplanations(t.db, guestA, document.id, [row]);
    expect(await listLensExplanations(t.db, guestA, document.id, analysisId)).toHaveLength(1);
  });
});
