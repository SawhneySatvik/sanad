/**
 * Samples service — the route layer's one call for POST /api/samples/:sampleId/open. Thin on
 * purpose: the actual reservation/replay logic, and the only construction of RecordedLlmClient,
 * lives in src/server/samples/open.ts (samples-isolation.test.ts pins that module boundary).
 */

import type { ServiceDeps } from "@/server/container";
import type { Principal } from "@/server/core/types";
import { openSample as openSampleDocument } from "@/server/samples/open";

/** Opens (or reuses) the caller's own copy of a bundled sample. Never touches deps.llm: see open.ts. */
export async function openSample(deps: ServiceDeps, principal: Principal, sampleId: string): Promise<{ documentId: string }> {
  return openSampleDocument(deps, principal, sampleId);
}
