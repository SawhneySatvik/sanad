import { route } from "@/server/http/handler";
import * as library from "@/server/services/library";
import { IdParams } from "@/shared/contracts/common";
import { DraftRevisionsOutput } from "@/shared/contracts/library";

export const GET = route({
  params: IdParams, usesLlm: false, response: DraftRevisionsOutput,
  run: ({ deps, principal, params }) => library.revisions(deps, principal, params.id),
});
