// Shared harness for the Prepare service tests — PrepareDeps = UnderstandDeps, so this reuses
// Understand's real-PGlite/real-storage/FakeLlmClient harness (createHarness()) wholesale rather
// than duplicating it.

import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { eligibleFindings, type PrepareGenerated, type PrepareResult } from "@/server/services/prepare";
import { analyze, type UnderstandFinding } from "@/server/services/understand";
import { guestA, type Harness, leaseOutput, MIME } from "@tests/support/services/understand";

export * from "@tests/support/services/understand";

/** Narrows a `PrepareResult` to its `complete` variant, or throws — for tests that expect success. */
export function complete(result: PrepareResult): PrepareGenerated {
  if (result.state !== "complete") throw new Error(`expected a complete result, got ${result.state}`);
  return result;
}

/** Analyzes the lease fixture as guestA, producing the findings a Prepare test grounds on. */
export async function analyzeLease(h: Harness) {
  const understandLlm = new FakeLlmClient({ responses: [{ data: leaseOutput() }] });
  const input = await h.upload(guestA, "leave_and_license.txt", MIME.txt);
  return analyze(h.deps(understandLlm), guestA, input);
}

// The exact alias ("F1", "F2", …) generate() will assign `target` within this document's eligible
// set for one call — computed via production's own eligibleFindings(), never a reimplemented copy
// of the filter, so a test can never silently drift from what generate() actually does.
export function aliasFor(findings: readonly UnderstandFinding[], target: UnderstandFinding): string {
  const index = eligibleFindings(findings).findIndex((finding) => finding.id === target.id);
  if (index === -1) throw new Error(`finding ${target.id} is not eligible for this call — cannot have an alias`);
  return `F${index + 1}`;
}

// An alias string guaranteed to never be assigned to a real finding in any of these tests (they all
// use the small `leaseOutput()` fixture, well under 90 eligible findings).
export const UNKNOWN_ALIAS = "F90";
