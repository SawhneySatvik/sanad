import { route } from "@/server/http/handler";
import * as library from "@/server/services/library";
import { IdParams } from "@/shared/contracts/common";
import { DocumentListRowOutput } from "@/shared/contracts/library";

export const DELETE = route({
  params: IdParams, usesLlm: false, response: DocumentListRowOutput,
  run: ({ deps, principal, params }) => library.unassign(deps, principal, "document", params.id),
});
