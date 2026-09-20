import { comparisonView } from "@/server/http/views/comparison-view";
import { route } from "@/server/http/handler";
import * as compare from "@/server/services/compare";
import { IdParams } from "@/shared/contracts/common";
import { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";

// get() re-verifies both sides against each document's current canonical_text on every call —
// stored statuses are audit fields only. It never reads deps.llm, so this route works even with no
// LLM keys configured.
export const GET = route({
  params: IdParams,
  response: ComparisonWithChangesOutput,
  usesLlm: false,
  run: async ({ deps, principal, params }) => comparisonView(await compare.get(deps, principal, params.id)),
});
