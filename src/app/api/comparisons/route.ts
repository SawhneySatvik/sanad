import { comparisonView } from "@/server/http/views/comparison-view";
import { route } from "@/server/http/handler";
import * as compare from "@/server/services/compare";
import { ComparisonOutput, CreateComparisonInput } from "@/shared/contracts/comparisons";

// compare() checks canAccess on both documents before any LLM call — a documentAId/documentBId
// naming another principal's document is the same 404 a missing one gets.
export const POST = route({
  body: CreateComparisonInput,
  response: ComparisonOutput,
  run: async ({ deps, principal, body }) => comparisonView(await compare.compare(deps, principal, body)),
});
