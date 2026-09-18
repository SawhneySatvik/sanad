// Cross-principal and cross-document cases live in finding-lens-explanations.idor.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@tests/support/db";
import { insertLensExplanations, listLensExplanations } from "@/server/data/finding-lens-explanations";
import { createRepoTestDb, guestA } from "@tests/support/data/documents";
import { documentWithFindings, LENSES } from "@tests/support/data/finding-lens-explanations";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

describe("insertLensExplanations / listLensExplanations", () => {
  it("stores one row per (finding, lens) and lists them in written order, scoped to the analysis", async () => {
    const { document, analysisId, findings } = await documentWithFindings(t, guestA, 2);
    const rows = findings.flatMap((finding) =>
      LENSES.map((lens) => ({ findingId: finding.id, roleStageLens: lens, explanation: `${finding.explanation} / ${lens}` })),
    );
    await insertLensExplanations(t.db, guestA, document.id, rows);

    const listed = await listLensExplanations(t.db, guestA, document.id, analysisId);
    expect(listed.map((row) => [row.findingId, row.roleStageLens, row.explanation])).toEqual(
      rows.map((row) => [row.findingId, row.roleStageLens, row.explanation]),
    );
    expect(await listLensExplanations(t.db, guestA, document.id, "00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect(await listLensExplanations(t.db, guestA, document.id, "not-a-uuid")).toEqual([]);
  });
});
