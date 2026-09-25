import { route } from "@/server/http/handler";
import * as library from "@/server/services/library";
import { IdParams } from "@/shared/contracts/common";
import { DeleteImpactOutput } from "@/shared/contracts/library";

export const GET = route({
  params: IdParams, usesLlm: false, response: DeleteImpactOutput,
  run: ({ deps, principal, params }) => library.deleteImpact(deps, principal, params.id),
});
