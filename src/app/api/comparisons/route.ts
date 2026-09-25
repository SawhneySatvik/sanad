import { comparisonView } from "@/server/http/views/comparison-view";
import { route } from "@/server/http/handler";
import * as compare from "@/server/services/compare";
import { ComparisonOutput, CreateComparisonInput } from "@/shared/contracts/comparisons";
import * as library from "@/server/services/library";
import { ComparisonListOutput, ListQuery } from "@/shared/contracts/library";

export const GET = route({
  query: ListQuery, usesLlm: false, response: ComparisonListOutput,
  run: ({ deps, principal, query }) => library.list(deps, principal, "comparison", query),
});

// compare() checks canAccess on both documents before any LLM call — a documentAId/documentBId
// naming another principal's document is the same 404 a missing one gets.
export const POST = route({
  body: CreateComparisonInput,
  response: ComparisonOutput,
  run: async ({ deps, principal, body }) => comparisonView(await compare.compare(deps, principal, body)),
});
