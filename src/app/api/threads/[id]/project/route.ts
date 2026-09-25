import { route } from "@/server/http/handler";
import * as library from "@/server/services/library";
import { IdParams } from "@/shared/contracts/common";
import { ThreadListRowOutput } from "@/shared/contracts/library";

export const DELETE = route({
  params: IdParams, usesLlm: false, response: ThreadListRowOutput,
  run: ({ deps, principal, params }) => library.unassign(deps, principal, "thread", params.id),
});
