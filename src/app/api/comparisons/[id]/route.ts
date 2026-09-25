import { comparisonView } from "@/server/http/views/comparison-view";
import { route } from "@/server/http/handler";
import * as compare from "@/server/services/compare";
import { IdParams } from "@/shared/contracts/common";
import { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import * as library from "@/server/services/library";
import { ComparisonListRowOutput, RenameInput } from "@/shared/contracts/library";

export const PATCH = route({
  params: IdParams, body: RenameInput, usesLlm: false, response: ComparisonListRowOutput,
  run: ({ deps, principal, params, body }) => library.rename(deps, principal, "comparison", params.id, body.title),
});

export const DELETE = route({
  params: IdParams, usesLlm: false, status: 204,
  run: ({ deps, principal, params }) => library.remove(deps, principal, "comparison", params.id),
});

// get() re-verifies both sides against each document's current canonical_text on every call —
// stored statuses are audit fields only. It never reads deps.llm, so this route works even with no
// LLM keys configured.
export const GET = route({
  params: IdParams,
  response: ComparisonWithChangesOutput,
  usesLlm: false,
  run: async ({ deps, principal, params }) => comparisonView(await compare.get(deps, principal, params.id)),
});
