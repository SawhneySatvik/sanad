// Shared setup for the lens-explanation repository tests.

import type { TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { verify } from "@/server/deterministic/verify";
import { insertAnalysisIfAbsent } from "@/server/data/analyses";
import { readyDocument, SAMPLE_QUOTE } from "@tests/support/data/documents";
import { insertFindings } from "@/server/data/findings";

/** Lens ids valid for the leave_and_license fixtures these tests use. */
export const LENSES = ["tenant_about_to_sign", "tenant_already_signed", "landlord_about_to_sign"];

/** A ready document with an analysis and `count` verified findings on the same quote, for lens-explanation tests to attach to. */
export async function documentWithFindings(t: TestDb, principal: Principal, count: number) {
  const document = await readyDocument(t, principal);
  const analysis = await insertAnalysisIfAbsent(t.db, principal, { documentId: document.id, promptVersion: "p", modelUsed: "m" });
  const findings = await insertFindings(t.db, principal, {
    documentId: document.id,
    analysisId: analysis!.id,
    modelUsed: "m",
    findings: Array.from({ length: count }, (_, i) => ({
      category: "obligation" as const,
      quote: SAMPLE_QUOTE,
      explanation: `finding ${i}`,
      verification: verify({ quote: SAMPLE_QUOTE, canonicalText: document.canonicalText!, inputMode: "text" }),
    })),
  });
  return { document, analysisId: analysis!.id, findings };
}
